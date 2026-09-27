// Huddle mods: named, shareable shell scripts that install/update tools or set
// up environment stuff inside a devcontainer or sbx sandbox at create time.
// Modeled on the firewall-groups store (see firewall-group-store.ts) but much
// simpler — a mod has no membership/rule semantics, it IS the shareable unit.
//
// Trust model: a mod runs with the SAME trust tier as Huddle's own
// install-ide.sh step — root, at create time, embedded/base64'd into the
// generated setup script exactly the way install-ide.sh is (see docker.ts's
// buildJbConfigScript/buildVscodeConfigScript and sbx.ts's
// startSandboxExclusive). This is deliberate: a mod is reviewed, shareable,
// git-trackable content (the same trust class as editing the base Dockerfile),
// not arbitrary end-user input — unlike devcontainer.json lifecycle commands,
// which stay unprivileged (docker.ts's buildLifecycleStep runs them via
// `su vscode -c`).
//
// No new firewall bypass: a mod's script goes through the exact same
// proxy/CA/allowlist path as everything else in the container/sandbox.
// `firewall_hint` is purely informational (surfaced in the UI so an operator
// knows which firewall group(s) to enable) — nothing here grants network
// access on its own.

import {
  listMods as dbListMods,
  getMod as dbGetMod,
  createMod as dbCreateMod,
  updateMod as dbUpdateMod,
  deleteMod as dbDeleteMod,
  logAudit,
  type ModRow,
} from './db';
import { notifyStateChanged } from './events';

export type ModRuntime = 'devcontainer' | 'sbx' | 'both';
export type Mod = ModRow;

const ID_RE = /^[a-z0-9-]+$/;
const RUNTIMES: ReadonlySet<string> = new Set(['devcontainer', 'sbx', 'both']);

export function validateModId(id: string): void {
  if (!id || !ID_RE.test(id)) {
    throw new Error(`invalid mod id "${id}" — must match ${ID_RE} (lowercase letters, digits, hyphens)`);
  }
}

export function isModRuntime(value: unknown): value is ModRuntime {
  return typeof value === 'string' && RUNTIMES.has(value);
}

export function listMods(): Mod[] {
  return dbListMods();
}

export function getMod(id: string): Mod | undefined {
  return dbGetMod(id);
}

export interface CreateModInput {
  id: string;
  name: string;
  description?: string;
  script: string;
  runtime?: ModRuntime;
  always_on?: boolean;
  enabled?: boolean;
  firewall_hint?: string;
  source?: 'manual' | 'startup-folder';
}

export function createMod(m: CreateModInput): Mod {
  validateModId(m.id);
  if (!m.name.trim()) throw new Error('name is required');
  if (dbGetMod(m.id)) throw new Error(`a mod with id "${m.id}" already exists`);
  dbCreateMod({
    id: m.id,
    name: m.name.trim(),
    description: m.description ?? '',
    script: m.script,
    runtime: m.runtime ?? 'both',
    always_on: m.always_on ? 1 : 0,
    enabled: m.enabled === false ? 0 : 1,
    firewall_hint: m.firewall_hint ?? '',
    source: m.source ?? 'manual',
  });
  logAudit({ containerId: null, domain: 'mods', action: 'admin:mod-create', path: `mod=${m.id}` });
  notifyStateChanged();
  return dbGetMod(m.id)!;
}

export interface UpdateModInput {
  name?: string;
  description?: string;
  script?: string;
  runtime?: ModRuntime;
  always_on?: boolean;
  enabled?: boolean;
  firewall_hint?: string;
}

export function updateMod(id: string, patch: UpdateModInput): Mod {
  const existing = dbGetMod(id);
  if (!existing) throw new Error(`mod "${id}" not found`);
  const dbPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('name cannot be empty');
    dbPatch.name = name;
  }
  if (patch.description !== undefined) dbPatch.description = patch.description;
  if (patch.script !== undefined) dbPatch.script = patch.script;
  if (patch.runtime !== undefined) dbPatch.runtime = patch.runtime;
  if (patch.always_on !== undefined) dbPatch.always_on = patch.always_on ? 1 : 0;
  if (patch.enabled !== undefined) dbPatch.enabled = patch.enabled ? 1 : 0;
  if (patch.firewall_hint !== undefined) dbPatch.firewall_hint = patch.firewall_hint;
  dbUpdateMod(id, dbPatch);
  notifyStateChanged();
  return dbGetMod(id)!;
}

export function deleteMod(id: string): void {
  if (!dbGetMod(id)) throw new Error(`mod "${id}" not found`);
  dbDeleteMod(id);
  logAudit({ containerId: null, domain: 'mods', action: 'admin:mod-delete', path: `mod=${id}` });
  notifyStateChanged();
}

// ── Resolving + rendering the script for a workspace create ─────────────────

function matchesRuntime(mod: Mod, runtime: 'devcontainer' | 'sbx'): boolean {
  return mod.runtime === 'both' || mod.runtime === runtime;
}

// Always-on mods PLUS the caller's opt-in selection, filtered to enabled mods
// matching this runtime, deduped, sorted by name for a deterministic script
// (mods run in this order, and a stable order is what makes a failing mod's
// position in the log reproducible).
export function resolveModsForWorkspace(selectedIds: string[] | undefined, runtime: 'devcontainer' | 'sbx'): Mod[] {
  const candidates = dbListMods().filter((m) => m.enabled && matchesRuntime(m, runtime));
  const selected = new Set(selectedIds ?? []);
  const resolved = candidates.filter((m) => m.always_on || selected.has(m.id));
  return resolved.sort((a, b) => a.name.localeCompare(b.name));
}

// Renders the resolved mods as a shell fragment, run as root (see the trust-
// model note above) — unlike buildLifecycleStep in docker.ts, there is no
// `su vscode -c` wrapper here. Each mod is wrapped in its own best-effort
// block so one failing mod does not abort the rest, matching the same
// best-effort idiom every other lifecycle/setup step in this codebase uses.
export function buildModsScript(mods: Mod[]): string {
  if (mods.length === 0) return '';
  const blocks = mods
    .map(
      (m) => `# huddle mod: ${m.id} — ${m.name}
( ${m.script}
) || echo "[huddle] mod:${m.id} exited non-zero" >&2`,
    )
    .join('\n\n');
  return `# huddle mods — root, same trust tier as install-ide.sh (see mods.ts)\n${blocks}`;
}

export function auditModsApplied(containerId: string | null, mods: Mod[]): void {
  if (mods.length === 0) return;
  logAudit({
    containerId,
    domain: 'mods',
    action: 'mods:apply',
    path: `ids=${mods.map((m) => m.id).join(',')}`,
  });
}
