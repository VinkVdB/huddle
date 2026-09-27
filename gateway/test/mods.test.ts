import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Exercises the real mods module against the in-memory DB (DB_PATH=':memory:'
// from vitest.config.ts): CRUD, resolveModsForWorkspace's always-on/opt-in
// union and runtime filtering, and buildModsScript's root-run, best-effort
// wrapping.

let dbMod: typeof import('../src/db');
let mods: typeof import('../src/mods');

beforeAll(async () => {
  dbMod = await import('../src/db');
  mods = await import('../src/mods');
  dbMod.initDb();
});

beforeEach(() => {
  dbMod.db.exec('DELETE FROM mods;');
});

describe('mods module', () => {
  it('creates a mod and reads it back', () => {
    const created = mods.createMod({ id: 'rustup', name: 'Rustup', script: 'curl https://sh.rustup.rs -sSf | sh' });
    expect(created.id).toBe('rustup');
    expect(created.runtime).toBe('both');
    expect(created.always_on).toBe(0);
    expect(created.enabled).toBe(1);
    expect(created.source).toBe('manual');
    expect(mods.getMod('rustup')).toMatchObject({ name: 'Rustup' });
  });

  it('rejects an invalid id', () => {
    expect(() => mods.createMod({ id: 'Rust Up!', name: 'x', script: 'true' })).toThrow(/invalid mod id/);
  });

  it('rejects a duplicate id', () => {
    mods.createMod({ id: 'rustup', name: 'Rustup', script: 'true' });
    expect(() => mods.createMod({ id: 'rustup', name: 'Rustup 2', script: 'true' })).toThrow(/already exists/);
  });

  it('updates a mod in place', () => {
    mods.createMod({ id: 'rustup', name: 'Rustup', script: 'true' });
    const updated = mods.updateMod('rustup', { always_on: true, enabled: false });
    expect(updated.always_on).toBe(1);
    expect(updated.enabled).toBe(0);
  });

  it('deletes a mod', () => {
    mods.createMod({ id: 'rustup', name: 'Rustup', script: 'true' });
    mods.deleteMod('rustup');
    expect(mods.getMod('rustup')).toBeUndefined();
    expect(() => mods.deleteMod('rustup')).toThrow(/not found/);
  });

  describe('resolveModsForWorkspace', () => {
    it('always-on mods are included with no selection', () => {
      mods.createMod({ id: 'a', name: 'A', script: 'true', always_on: true });
      mods.createMod({ id: 'b', name: 'B', script: 'true', always_on: false });
      const resolved = mods.resolveModsForWorkspace(undefined, 'devcontainer');
      expect(resolved.map((m) => m.id)).toEqual(['a']);
    });

    it('opt-in mods are included only when selected', () => {
      mods.createMod({ id: 'a', name: 'A', script: 'true' });
      mods.createMod({ id: 'b', name: 'B', script: 'true' });
      const resolved = mods.resolveModsForWorkspace(['b'], 'devcontainer');
      expect(resolved.map((m) => m.id)).toEqual(['b']);
    });

    it('filters by runtime', () => {
      mods.createMod({ id: 'a', name: 'A', script: 'true', always_on: true, runtime: 'sbx' });
      mods.createMod({ id: 'b', name: 'B', script: 'true', always_on: true, runtime: 'devcontainer' });
      mods.createMod({ id: 'c', name: 'C', script: 'true', always_on: true, runtime: 'both' });
      expect(mods.resolveModsForWorkspace(undefined, 'sbx').map((m) => m.id)).toEqual(['a', 'c']);
      expect(mods.resolveModsForWorkspace(undefined, 'devcontainer').map((m) => m.id)).toEqual(['b', 'c']);
    });

    it('drops a disabled mod even if always-on or selected', () => {
      mods.createMod({ id: 'a', name: 'A', script: 'true', always_on: true, enabled: false });
      expect(mods.resolveModsForWorkspace(['a'], 'devcontainer')).toEqual([]);
    });

    it('dedups an always-on mod that is also explicitly selected, sorted by name', () => {
      mods.createMod({ id: 'z', name: 'Zeta', script: 'true', always_on: true });
      mods.createMod({ id: 'a', name: 'Alpha', script: 'true' });
      const resolved = mods.resolveModsForWorkspace(['z', 'a'], 'devcontainer');
      expect(resolved.map((m) => m.id)).toEqual(['a', 'z']);
    });
  });

  describe('buildModsScript', () => {
    it('renders nothing for an empty list', () => {
      expect(mods.buildModsScript([])).toBe('');
    });

    it('wraps each mod in a best-effort, root-run block', () => {
      const list = [
        mods.createMod({ id: 'a', name: 'A', script: 'echo one' }),
        mods.createMod({ id: 'b', name: 'B', script: 'echo two' }),
      ];
      const script = mods.buildModsScript(list);
      expect(script).toContain('# huddle mod: a — A');
      expect(script).toContain('echo one');
      expect(script).toContain('[huddle] mod:a exited non-zero');
      expect(script).toContain('# huddle mod: b — B');
      expect(script).toContain('echo two');
      // Root-run: no su/sudo wrapper, unlike docker.ts's buildLifecycleStep.
      expect(script).not.toContain('su vscode');
    });
  });
});
