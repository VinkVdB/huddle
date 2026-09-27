// The team-managed mods folder: mirrors firewall-rules-folder.ts closely (see
// that file's header for the full rationale) — a mod is simpler than a
// firewall group (one row, no membership/rule set), so this is a lighter
// version of the same reload/sync shape.
//
// Reading (reload) treats the folder as the source of truth for the mods it
// manages; writing (sync) mirrors the portal's mods back out as files a team
// keeps in Git. Envelope shape/validation lives in ./mods-envelope, database
// work in ./mods (via db.ts's low-level mod functions) — this module only
// does file I/O and the bookkeeping that maps files to mods.

import fs from 'fs';
import path from 'path';
import { db, createMod as dbCreateMod, updateMod as dbUpdateMod, getMod as dbGetMod, logAudit, type ModRow } from './db';
import { notifyStateChanged } from './events';
import { runtimeEnv } from './runtime-env';
import { readHostConfig } from './host-config';
import { serializeModEnvelope, validateModEnvelope, type ModEnvelope } from './mods-envelope';
import { listMods } from './mods';

// Where the team mods folder actually is, for THIS process — same override /
// host-mode logic as firewallRulesMount()/teamExtDir(): Huddle Node runs on
// the host and reads the folder straight out of the CLI config, per call, so
// `huddle mods folder set` (CLI or portal) takes effect on the next reload
// instead of needing a restart.
export function modsFolderMount(): string {
  const override = process.env.HUDDLE_MODS_MOUNT?.trim();
  if (override) return override;
  if (runtimeEnv.hostMode) return readHostConfig().modsFolder?.trim() || '';
  return runtimeEnv.modsFolderMount;
}

function listEnvelopeFiles(mount: string, sorted: boolean): string[] | null {
  try {
    const files = fs.readdirSync(mount).filter((f) => f.toLowerCase().endsWith('.json'));
    return sorted ? files.sort() : files;
  } catch {
    return null;
  }
}

// A mod script is a handful of kilobytes at most; the cap exists so a single
// file cannot decide how much memory Huddle Node allocates during startup —
// same defense and same limit as MAX_ENVELOPE_BYTES in firewall-rules-folder.ts.
const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024;

// The ONLY way this module turns a file name into a path — see the identical
// guard (and its comment) in firewall-rules-folder.ts's envelopePath().
function envelopePath(mount: string, file: string): string {
  if (!file || file !== path.basename(file) || file === '.' || file === '..') {
    throw new Error(`not a plain file name: "${file}"`);
  }
  return path.join(mount, file);
}

function readEnvelopeFile(mount: string, file: string): ModEnvelope {
  const full = envelopePath(mount, file);
  // lstat, not stat: reject a symlink on its own terms before it is ever
  // opened — same "evil.json -> /dev/zero" defense as the firewall-rules
  // folder (reloadModsFolder runs during API startup, so following one would
  // hang Huddle Node rather than fail one request).
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) throw new Error('not a regular file (symlinks and directories are not read)');
  if (stat.size > MAX_ENVELOPE_BYTES) {
    throw new Error(`is ${stat.size} bytes, over the ${MAX_ENVELOPE_BYTES}-byte limit for a mod file`);
  }
  return validateModEnvelope(JSON.parse(fs.readFileSync(full, 'utf8')));
}

// ── Reload: folder → portal ─────────────────────────────────────────────────

export interface ModsFolderReloadSummary {
  folder: string | null;
  mounted: boolean;
  files: number;
  imported: number;
  updated: number;
  errors: { file: string; message: string }[];
}

// Read + validate EVERY file before touching the live mod set — a single
// malformed/unreadable file must not wipe the last-good team mods, so the
// caller aborts when this reports any error, same as parseEnvelopeFiles in
// firewall-rules-folder.ts.
function parseEnvelopeFiles(
  mount: string,
  entries: string[],
  summary: ModsFolderReloadSummary,
): { file: string; env: ModEnvelope }[] {
  const parsed: { file: string; env: ModEnvelope }[] = [];
  const seenIds = new Map<string, string>();
  for (const file of entries) {
    summary.files++;
    try {
      const env = readEnvelopeFile(mount, file);
      const prior = seenIds.get(env.mod.id);
      if (prior) throw new Error(`duplicate mod id "${env.mod.id}" (already declared in ${prior})`);
      seenIds.set(env.mod.id, file);
      parsed.push({ file, env });
    } catch (err) {
      summary.errors.push({ file, message: (err as Error).message });
    }
  }
  return parsed;
}

// Create the mod or update the one that already carries this id. Throws when
// the team folder would hijack a manually-created mod, same guard as
// upsertGroupRow() in firewall-group-store.ts.
function upsertModRow(env: ModEnvelope, source: string): void {
  const existing = dbGetMod(env.mod.id);
  if (!existing) {
    dbCreateMod({
      id: env.mod.id,
      name: env.mod.name,
      description: env.mod.description ?? '',
      script: env.script,
      runtime: env.mod.runtime,
      always_on: env.mod.always_on ? 1 : 0,
      enabled: 1,
      firewall_hint: env.mod.firewall_hint ?? '',
      source,
    });
    return;
  }
  if (source === 'startup-folder' && existing.source !== 'startup-folder') {
    throw new Error(`a ${existing.source} mod with id "${env.mod.id}" already exists — not overwriting it from the team folder`);
  }
  dbUpdateMod(env.mod.id, {
    name: env.mod.name,
    description: env.mod.description ?? '',
    script: env.script,
    runtime: env.mod.runtime,
    always_on: env.mod.always_on ? 1 : 0,
    firewall_hint: env.mod.firewall_hint ?? '',
    source,
  });
}

// Drop every startup-folder mod that is no longer in the fresh set, then
// upsert the fresh set — inside a single transaction, so a failure partway
// through (e.g. a folder id colliding with a manual mod) rolls the whole
// thing back and preserves the last-good mod set instead of leaving it
// half-cleared. Mirrors applyParsedEnvelopes in firewall-rules-folder.ts.
function applyParsedEnvelopes(parsed: { file: string; env: ModEnvelope }[], summary: ModsFolderReloadSummary): void {
  const apply = db.transaction(() => {
    const keep = new Set(parsed.map((p) => p.env.mod.id));
    const folderMods = db.prepare(`SELECT id FROM mods WHERE source = 'startup-folder'`).all() as { id: string }[];
    for (const { id } of folderMods) {
      if (!keep.has(id)) db.prepare('DELETE FROM mods WHERE id = ?').run(id);
    }
    for (const { file, env } of parsed) {
      const existed = !!dbGetMod(env.mod.id);
      try {
        upsertModRow(env, 'startup-folder');
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
      if (existed) summary.updated++;
      else summary.imported++;
    }
  });
  apply();
}

export function reloadModsFolder(): ModsFolderReloadSummary {
  const mount = modsFolderMount();
  const summary: ModsFolderReloadSummary = { folder: mount, mounted: false, files: 0, imported: 0, updated: 0, errors: [] };

  const entries = listEnvelopeFiles(mount, true);
  if (entries === null) return summary;
  summary.mounted = true;

  const parsed = parseEnvelopeFiles(mount, entries, summary);
  if (summary.errors.length > 0) {
    logAudit({
      containerId: null,
      domain: 'mods',
      action: 'admin:mods-folder-reload-aborted',
      path: `mount=${mount} files=${summary.files} errors=${summary.errors.length} (previous mods kept)`,
    });
    return summary;
  }

  try {
    applyParsedEnvelopes(parsed, summary);
  } catch (err) {
    summary.imported = 0;
    summary.updated = 0;
    summary.errors.push({ file: '(reload aborted)', message: (err as Error).message });
    logAudit({
      containerId: null,
      domain: 'mods',
      action: 'admin:mods-folder-reload-aborted',
      path: `mount=${mount} files=${summary.files} error=${(err as Error).message} (previous mods kept)`,
    });
    notifyStateChanged();
    return summary;
  }

  logAudit({
    containerId: null,
    domain: 'mods',
    action: 'admin:mods-folder-reload',
    path: `mount=${mount} files=${summary.files} imported=${summary.imported} updated=${summary.updated} errors=${summary.errors.length}`,
  });
  notifyStateChanged();
  return summary;
}

// ── Sync: portal → folder ───────────────────────────────────────────────────

export interface ModsFolderSyncSummary {
  folder: string | null;
  mounted: boolean;
  writable: boolean;
  written: number;
  pruned: number;
  files: { file: string; mod: string }[];
  errors: { file: string; message: string }[];
}

function modFileSlug(id: string): string {
  return id || 'mod';
}

function toEnvelope(m: ModRow): ModEnvelope {
  return {
    version: 1,
    kind: 'huddle-mod',
    exported_at: Math.floor(Date.now() / 1000),
    mod: {
      id: m.id,
      name: m.name,
      description: m.description,
      runtime: m.runtime as ModEnvelope['mod']['runtime'],
      always_on: m.always_on === 1,
      firewall_hint: m.firewall_hint,
    },
    script: m.script,
  };
}

export function syncModsToFolder(): ModsFolderSyncSummary {
  const mount = modsFolderMount();
  const summary: ModsFolderSyncSummary = { folder: mount, mounted: false, writable: false, written: 0, pruned: 0, files: [], errors: [] };

  const existing = listEnvelopeFiles(mount, false);
  if (existing === null) return summary;
  summary.mounted = true;

  const all = listMods();
  const currentIds = new Set(all.map((m) => m.id));
  const usedFiles = new Set<string>();

  for (const m of all) {
    const file = `${modFileSlug(m.id)}.json`;
    usedFiles.add(file);
    try {
      fs.writeFileSync(envelopePath(mount, file), serializeModEnvelope(toEnvelope(m)));
      summary.writable = true;
      summary.written++;
      summary.files.push({ file, mod: m.name });
      // Re-tag as folder-managed so the next reload updates it in place
      // instead of aborting on the "don't overwrite a manual mod" guard.
      dbUpdateMod(m.id, { source: 'startup-folder' });
    } catch (err) {
      summary.errors.push({ file, message: (err as Error).message });
    }
  }

  // Prune envelope files whose mod no longer exists, so the folder mirrors
  // the current set (a mod deleted in the portal would otherwise resurrect
  // on the next reload). Only files that parse as a recognisable mod
  // envelope with a now-missing id are ever removed.
  for (const f of existing) {
    if (usedFiles.has(f)) continue;
    let id: string | undefined;
    try {
      id = readEnvelopeFile(mount, f).mod.id;
    } catch {
      continue; // not a recognisable mod envelope — leave it untouched
    }
    if (id && !currentIds.has(id)) {
      try {
        fs.unlinkSync(envelopePath(mount, f));
        summary.pruned++;
      } catch (err) {
        summary.errors.push({ file: f, message: (err as Error).message });
      }
    }
  }

  logAudit({
    containerId: null,
    domain: 'mods',
    action: 'admin:mods-folder-sync',
    path: `mount=${mount} written=${summary.written} pruned=${summary.pruned} errors=${summary.errors.length}`,
  });
  notifyStateChanged();
  return summary;
}
