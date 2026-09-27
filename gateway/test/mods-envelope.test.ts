import { describe, it, expect } from 'vitest';
import { validateModEnvelope, serializeModEnvelope, MOD_ENVELOPE_KIND, MOD_ENVELOPE_VERSION } from '../src/mods-envelope';

// Pure validation module (no DB, no filesystem) — mirrors
// firewall-group-envelope.test.ts's coverage shape for the mods envelope.

const validRaw = () => ({
  version: 1,
  kind: 'huddle-mod',
  mod: { id: 'rustup', name: 'Rustup', description: 'Installs rustup', runtime: 'both', always_on: false, firewall_hint: 'rustup.rs, static.rust-lang.org' },
  script: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
});

describe('validateModEnvelope', () => {
  it('accepts a full, well-formed envelope', () => {
    const env = validateModEnvelope(validRaw());
    expect(env.mod.id).toBe('rustup');
    expect(env.mod.runtime).toBe('both');
    expect(env.script).toContain('rustup.rs');
  });

  it('defaults runtime to "both" when omitted', () => {
    const raw = validRaw();
    delete (raw.mod as any).runtime;
    expect(validateModEnvelope(raw).mod.runtime).toBe('both');
  });

  it('tolerates a bare { id, name, script } without the "mod" wrapper', () => {
    const env = validateModEnvelope({ id: 'x', name: 'X', script: 'true' });
    expect(env.mod).toMatchObject({ id: 'x', name: 'X' });
    expect(env.script).toBe('true');
  });

  it('rejects a missing/invalid id', () => {
    const raw = validRaw();
    (raw.mod as any).id = 'Not Valid!';
    expect(() => validateModEnvelope(raw)).toThrow(/mod\.id/);
  });

  it('rejects a missing name', () => {
    const raw = validRaw();
    (raw.mod as any).name = '';
    expect(() => validateModEnvelope(raw)).toThrow(/mod\.name/);
  });

  it('rejects an invalid runtime by falling back to "both" rather than throwing', () => {
    // Unknown runtime values degrade to the permissive default instead of
    // rejecting the whole envelope — mirrors how validateGroupEnvelope treats
    // unrecognised optional fields leniently while still enforcing required ones.
    const raw = validRaw();
    (raw.mod as any).runtime = 'windows';
    expect(validateModEnvelope(raw).mod.runtime).toBe('both');
  });

  it('rejects a missing script', () => {
    const raw = validRaw() as any;
    delete raw.script;
    expect(() => validateModEnvelope(raw)).toThrow(/script/);
  });

  it('rejects a non-object envelope', () => {
    expect(() => validateModEnvelope('nope')).toThrow(/must be an object/);
    expect(() => validateModEnvelope(null)).toThrow(/must be an object/);
    expect(() => validateModEnvelope([])).toThrow(/must be an object/);
  });

  it('round-trips through serializeModEnvelope as stable, diff-friendly JSON', () => {
    const env = validateModEnvelope(validRaw());
    const text = serializeModEnvelope(env);
    expect(text.endsWith('\n')).toBe(true);
    expect(validateModEnvelope(JSON.parse(text))).toEqual(env);
  });

  it('defaults version/kind when absent', () => {
    const raw = validRaw() as any;
    delete raw.version;
    delete raw.kind;
    const env = validateModEnvelope(raw);
    expect(env.version).toBe(MOD_ENVELOPE_VERSION);
    expect(env.kind).toBe(MOD_ENVELOPE_KIND);
  });
});
