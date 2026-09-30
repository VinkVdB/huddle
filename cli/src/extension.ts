import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { get, del, uploadFile } from './api';
import { createZip, type ZipEntry } from './zip';
import { CONTAINER } from './init';
import { resolveRuntime } from './runtime';
import { printTable, dim, green, yellow } from './utils';

export interface ExtensionManifest {
  id: string;
  name: string;
  version?: string | null;
}

export interface InstalledExtension extends ExtensionManifest {
  enabled?: boolean;
}

export type InstallPlan =
  | { action: 'install' }
  | { action: 'update'; from: string }
  | { action: 'refuse'; reason: string };

const SKIPPED = new Set(['node_modules']);

/** Reads an extension folder into zip entries; the manifest must pass the gateway's own id rule. */
export function collectExtensionFiles(dir: string): { manifest: ExtensionManifest; entries: ZipEntry[] } {
  const root = path.resolve(dir);
  for (const required of ['manifest.json', 'index.js']) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`${required} missing in ${root}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as ExtensionManifest;
  if (typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error(`manifest id ${JSON.stringify(manifest.id)} must be lowercase letters, digits and -`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('manifest name is required');

  const entries: ZipEntry[] = [];
  const walk = (rel: string): void => {
    for (const item of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (item.name.startsWith('.') || SKIPPED.has(item.name)) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(childRel);
      else if (item.isFile()) entries.push({ name: childRel, data: fs.readFileSync(path.join(root, childRel)) });
    }
  };
  walk('');
  return { manifest, entries };
}

/** An id already taken by an extension with another name is someone else's; only --force replaces it. */
export function planInstall(incoming: ExtensionManifest, installed: InstalledExtension[], force: boolean): InstallPlan {
  const existing = installed.find((e) => e.id === incoming.id);
  if (!existing) return { action: 'install' };
  const from = existing.version ?? 'unknown';
  if (existing.name !== incoming.name && !force) {
    return {
      action: 'refuse',
      reason: `id '${incoming.id}' belongs to "${existing.name}" (v${from}), not "${incoming.name}". Use --force to replace it.`,
    };
  }
  return { action: 'update', from };
}

export async function runExtensionList(): Promise<void> {
  const installed = await get<InstalledExtension[]>('/api/extensions');
  if (!installed.length) {
    console.log('No extensions installed.');
    return;
  }
  printTable(
    ['ID', 'NAME', 'VERSION', 'ENABLED'],
    installed.map((e) => [e.id, e.name, e.version ?? '-', e.enabled === false ? 'no' : 'yes']),
  );
}

export async function runExtensionInstall(dir: string, opts: { force: boolean; restart: boolean }): Promise<void> {
  const { manifest, entries } = collectExtensionFiles(dir);
  const plan = planInstall(manifest, await get<InstalledExtension[]>('/api/extensions'), opts.force);
  if (plan.action === 'refuse') throw new Error(plan.reason);

  const result = await uploadFile<{ id: string; restartRequired: boolean }>(
    '/api/extensions/upload',
    `${manifest.id}.zip`,
    createZip(entries),
  );
  const verb = plan.action === 'update' ? `Updated ${manifest.id} v${plan.from} → v${manifest.version ?? '?'}` : `Installed ${manifest.id} v${manifest.version ?? '?'}`;
  console.log(green(`[OK] ${verb}`));

  if (!result.restartRequired) return;
  if (!opts.restart) {
    console.log(yellow('The gateway keeps running the old code until it restarts. Re-run with --restart, or restart the huddle container.'));
    return;
  }
  const rt = resolveRuntime().name;
  console.log(dim(`Restarting the gateway process (${rt} restart ${CONTAINER}); the container itself is kept.`));
  execFileSync(rt, ['restart', CONTAINER], { stdio: 'ignore' });
  console.log(green('[OK] Gateway restarted with the new extension code.'));
}

export async function runExtensionRemove(id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid extension id: ${id}`);
  await del(`/api/extensions/${id}`);
  console.log(green(`[OK] Removed ${id}`));
}
