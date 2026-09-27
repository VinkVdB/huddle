// `huddle mods folder ...` — CLI surface for the team-managed mods folder
// (gateway/src/mods-folder.ts). Mirrors `firewall.ts`'s runFirewallFolder
// exactly; mod authoring/import/export/toggling is UI-only (the portal's Mods
// page), this command only points Huddle Node at the shared folder.

import { post } from './api';
import { readConfig, updateConfig } from './config';
import { dim, green, red, cyan } from './utils';

export interface ModsFolderOptions {
  action?: string; // show | set | reload | sync
  path?: string;
}

export async function runModsFolder(opts: ModsFolderOptions): Promise<void> {
  const action = opts.action ?? 'show';

  if (action === 'show') {
    const folder = readConfig().modsFolder;
    console.log(folder ? folder : dim('(no mods folder configured)'));
    return;
  }

  if (action === 'set') {
    const path = (opts.path ?? '').trim();
    if (!path) throw new Error('Usage: huddle mods folder set <path>');
    // Config-only: Huddle Node reads this file per call, so the new folder is
    // live immediately — no remount, no restart.
    updateConfig({ modsFolder: path });
    console.log(green(`[OK] Mods folder set to ${cyan(path)}`));
    console.log(dim('  Read on start and on `huddle mods folder reload`.'));
    return;
  }

  if (action === 'reload') {
    const res = await post<{ folder: string | null; mounted: boolean; files: number; imported: number; updated: number; errors: { file: string; message: string }[] }>(
      '/api/mods-folder/reload',
      {},
    );
    if (!res.mounted) {
      console.log(dim(res.folder
        ? `Cannot read ${res.folder} — set an existing folder with \`huddle mods folder set <path>\`.`
        : 'No mods folder configured. Set one with `huddle mods folder set <path>`.'));
      return;
    }
    console.log(green(`[OK] Reloaded: ${res.imported} imported, ${res.updated} updated, ${res.errors.length} error(s)`));
    for (const e of res.errors) console.error(red(`  [!] ${e.file}: ${e.message}`));
    return;
  }

  if (action === 'sync') {
    const res = await post<{ folder: string | null; mounted: boolean; writable: boolean; written: number; pruned: number; files: { file: string; mod: string }[]; errors: { file: string; message: string }[] }>(
      '/api/mods-folder/sync',
      {},
    );
    if (!res.mounted) {
      console.log(dim(res.folder
        ? `Cannot read ${res.folder} — set an existing folder with \`huddle mods folder set <path>\`.`
        : 'No mods folder configured. Set one with `huddle mods folder set <path>`.'));
      return;
    }
    if (res.written === 0 && res.errors.length > 0) {
      console.error(red('[!] Could not write to the folder — check that Huddle Node may write there.'));
      for (const e of res.errors) console.error(red(`  [!] ${e.file}: ${e.message}`));
      return;
    }
    console.log(green(`[OK] Synced: ${res.written} mod(s) written, ${res.pruned} stale file(s) removed, ${res.errors.length} error(s)`));
    for (const e of res.errors) console.error(red(`  [!] ${e.file}: ${e.message}`));
    return;
  }

  throw new Error(`Unknown folder action: ${action}. Use show | set | reload | sync.`);
}
