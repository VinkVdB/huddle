import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exercises the real mods-folder module against the in-memory DB
// (DB_PATH=':memory:' from vitest.config.ts): reload (folder → DB) and sync
// (DB → folder), including the same defenses firewall-rules-folder.test
// covers — symlink rejection, size cap, idempotent reload, manual-mod
// protection.

let dbMod: typeof import('../src/db');
let modsFolder: typeof import('../src/mods-folder');
let mods: typeof import('../src/mods');

beforeAll(async () => {
  dbMod = await import('../src/db');
  modsFolder = await import('../src/mods-folder');
  mods = await import('../src/mods');
  dbMod.initDb();
});

beforeEach(() => {
  dbMod.db.exec('DELETE FROM mods;');
});

afterEach(() => {
  delete process.env.HUDDLE_MODS_MOUNT;
});

const modEnvelope = (id: string, name: string) => ({
  version: 1,
  kind: 'huddle-mod',
  mod: { id, name, runtime: 'both' },
  script: `echo installing ${id}`,
});

describe('mods-folder module', () => {
  it('reports not-mounted when the folder is unset', () => {
    process.env.HUDDLE_MODS_MOUNT = path.join(os.tmpdir(), `huddle-mods-missing-${process.pid}`);
    const res = modsFolder.reloadModsFolder();
    expect(res.mounted).toBe(false);
  });

  it('loads mods from a team folder and removes stale startup-folder mods on reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify(modEnvelope('rustup', 'Rustup')));
    fs.writeFileSync(path.join(dir, 'nvm.json'), JSON.stringify(modEnvelope('nvm', 'nvm')));
    process.env.HUDDLE_MODS_MOUNT = dir;

    const first = modsFolder.reloadModsFolder();
    expect(first.mounted).toBe(true);
    expect(first.imported).toBe(2);
    expect(first.errors).toHaveLength(0);
    expect(mods.listMods().map((m) => m.id).sort()).toEqual(['nvm', 'rustup']);
    expect(mods.getMod('rustup')!.source).toBe('startup-folder');

    fs.rmSync(path.join(dir, 'nvm.json'));
    const second = modsFolder.reloadModsFolder();
    // rustup already existed from the first reload, so it's an update, not a
    // fresh import; nvm.json is gone so it's dropped rather than re-imported.
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    expect(mods.listMods().map((m) => m.id)).toEqual(['rustup']);
  });

  it('updates an existing startup-folder mod in place on reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify(modEnvelope('rustup', 'Rustup')));
    process.env.HUDDLE_MODS_MOUNT = dir;
    modsFolder.reloadModsFolder();

    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify({ ...modEnvelope('rustup', 'Rustup (updated)'), script: 'echo v2' }));
    const res = modsFolder.reloadModsFolder();
    expect(res.updated).toBe(1);
    expect(res.imported).toBe(0);
    expect(mods.getMod('rustup')).toMatchObject({ name: 'Rustup (updated)', script: 'echo v2' });
  });

  it('refuses to read a symlinked mod file instead of following it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify(modEnvelope('rustup', 'Rustup')));
    const outside = path.join(dir, '..', `huddle-mods-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(modEnvelope('outside', 'Outside')));
    fs.symlinkSync(outside, path.join(dir, 'linked.json'));

    process.env.HUDDLE_MODS_MOUNT = dir;
    const res = modsFolder.reloadModsFolder();
    expect(res.errors.map((e) => e.file)).toContain('linked.json');
    expect(res.errors.find((e) => e.file === 'linked.json')!.message).toMatch(/regular file/);
    // Fail-closed: one unreadable file aborts the whole reload.
    expect(res.imported).toBe(0);
    expect(mods.listMods()).toHaveLength(0);
    fs.rmSync(outside);
  });

  it('refuses a mod file over the size limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    const huge = { ...modEnvelope('rustup', 'Rustup'), script: 'x'.repeat(6 * 1024 * 1024) };
    fs.writeFileSync(path.join(dir, 'huge.json'), JSON.stringify(huge));

    process.env.HUDDLE_MODS_MOUNT = dir;
    const res = modsFolder.reloadModsFolder();
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/over the .* limit/);
    expect(mods.listMods()).toHaveLength(0);
  });

  it('rejects two files declaring the same mod id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(modEnvelope('rustup', 'Rustup A')));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(modEnvelope('rustup', 'Rustup B')));

    process.env.HUDDLE_MODS_MOUNT = dir;
    const res = modsFolder.reloadModsFolder();
    expect(res.errors.some((e) => e.message.includes('duplicate mod id'))).toBe(true);
    expect(mods.listMods()).toHaveLength(0);
  });

  it('does not let the folder hijack a manually-created mod with the same id', () => {
    mods.createMod({ id: 'rustup', name: 'Manual Rustup', script: 'true' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify(modEnvelope('rustup', 'Folder Rustup')));
    process.env.HUDDLE_MODS_MOUNT = dir;

    const res = modsFolder.reloadModsFolder();
    expect(res.errors.length).toBeGreaterThan(0);
    // Aborted — the manual mod is untouched.
    expect(mods.getMod('rustup')).toMatchObject({ name: 'Manual Rustup', source: 'manual' });
  });

  it('does not touch a manual mod that is unrelated to the folder', () => {
    mods.createMod({ id: 'manual-one', name: 'Manual One', script: 'true' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-'));
    fs.writeFileSync(path.join(dir, 'rustup.json'), JSON.stringify(modEnvelope('rustup', 'Rustup')));
    process.env.HUDDLE_MODS_MOUNT = dir;

    modsFolder.reloadModsFolder();
    expect(mods.getMod('manual-one')).toMatchObject({ source: 'manual' });
    expect(mods.getMod('rustup')).toMatchObject({ source: 'startup-folder' });
  });

  it('syncs the current mod set back out to the folder and prunes stale files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mods-sync-'));
    process.env.HUDDLE_MODS_MOUNT = dir;
    mods.createMod({ id: 'rustup', name: 'Rustup', script: 'echo rustup' });

    const res = modsFolder.syncModsToFolder();
    expect(res.written).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['rustup.json']);
    expect(mods.getMod('rustup')!.source).toBe('startup-folder');

    mods.deleteMod('rustup');
    const pruned = modsFolder.syncModsToFolder();
    expect(pruned.pruned).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
