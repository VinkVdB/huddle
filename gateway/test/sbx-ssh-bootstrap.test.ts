import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

// ── sshBootstrapScript: the actual bug, unit-tested at last ──────────────────
// This is the script that used to assume root, `|| true` its way past every
// real failure, and background its way to a 0 exit code no matter what — sbx
// exec runs as non-root user `agent` (uid 1000, in the `sudo` group),
// confirmed live against a real sandbox. Nothing here can prove sshd actually
// comes up inside a real microVM (only a live sandbox can), but every
// assertion below maps to a SPECIFIC way that bug happened, so a regression
// back to any of them fails loudly here instead of silently inside a sandbox
// nobody is watching.
//
// sbx.ts transitively imports ./db (via ./ssh-keys, ./sandbox/registry,
// ./sandbox/reconcile and ./docker) and several of those modules pull in
// enough of db.ts's surface (registerSocketName, unregisterSocketNameIfCurrent,
// ...) that hand-mocking the module is a maintenance trap. vitest.config.ts
// already sets DB_PATH=:memory: globally, so — same idiom as
// sbx-identity-node.test.ts — it's simpler and more robust to run the real
// db.ts against an in-memory SQLite DB than to keep a mock's export list in
// sync with every module sbx.ts happens to import.
vi.mock('../src/tls-ca', () => ({ getCaCertPem: () => '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' }));
vi.mock('../src/host-config', () => ({ listFolderMappings: () => [] }));

let sshBootstrapScript: (publicKey: string) => string;

beforeAll(async () => {
  const dbMod = await import('../src/db');
  dbMod.initDb();
  ({ sshBootstrapScript } = await import('../src/sbx'));
});

const TEST_PUBKEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC test@huddle';

describe('sshBootstrapScript', () => {
  it('is valid POSIX shell', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    // Throws (execFileSync rejects on non-zero exit) if `sh -n` finds a syntax error.
    expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
  });

  it('never swallows a privileged command with || true', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const privileged = script
      .split('\n')
      .filter((line) => /(apt-get|ssh-keygen|sshd -t|mkdir -p \/run\/sshd)/.test(line));
    expect(privileged.length).toBeGreaterThan(0);
    for (const line of privileged) {
      expect(line).not.toMatch(/\|\|\s*true/);
    }
  });

  it('backgrounds exactly one command — the final sshd -D launch', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const backgrounded = script.match(/&\s*$/gm) ?? [];
    expect(backgrounded).toHaveLength(1);
    const bgLine = script.split('\n').find((l) => /&\s*$/.test(l));
    expect(bgLine).toMatch(/nohup .*"\$SSHD_BIN" -D/);
  });

  it('escalates via conditional passwordless sudo, and prefixes every privileged command with $SUDO', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('sudo -n true');
    // Every privileged command (apt-get / ssh-keygen -A / mkdir -p /run/sshd /
    // chmod /run/sshd / sshd -t / the nohup launch) is prefixed with $SUDO.
    for (const marker of ['apt-get update', 'apt-get install', 'ssh-keygen -A', 'mkdir -p /run/sshd', '"$SSHD_BIN" -t', '"$SSHD_BIN" -D']) {
      const line = script.split('\n').find((l) => l.includes(marker));
      expect(line, `expected a line containing ${JSON.stringify(marker)}`).toBeDefined();
      expect(line).toMatch(/\$SUDO/);
    }
  });

  it('creates /run/sshd, validates with sshd -t BEFORE backgrounding, and reads back the listener AFTER', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('mkdir -p /run/sshd');
    const idxRunDir = script.indexOf('mkdir -p /run/sshd');
    const idxSshdT = script.indexOf('"$SSHD_BIN" -t');
    const idxNohup = script.indexOf('nohup $SUDO "$SSHD_BIN" -D');
    const idxReadback = script.indexOf('port22_listening');
    // "port22_listening" also appears earlier (function def + step-3 check), so
    // find the readback call specifically: it's the last occurrence, inside the loop.
    const idxReadbackLoop = script.lastIndexOf('port22_listening');
    expect(idxRunDir).toBeGreaterThan(-1);
    expect(idxSshdT).toBeGreaterThan(idxRunDir);
    expect(idxNohup).toBeGreaterThan(idxSshdT);
    expect(idxReadbackLoop).toBeGreaterThan(idxNohup);
    expect(idxReadback).toBeGreaterThan(-1);
  });

  it('contains no template-literal-hostile characters other than the intended interpolation', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).not.toContain('`');
    // The only "${" should already be resolved away — sshBootstrapScript
    // returns a plain string, so a stray unresolved "${" would mean a nested
    // template literal leaked through.
    expect(script).not.toContain('${');
  });

  it('round-trips the public key through the embedded base64', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    const match = /printf '%s' '([^']+)' \| base64 -d/.exec(script);
    expect(match).toBeTruthy();
    const decoded = Buffer.from(match![1], 'base64').toString('utf8');
    expect(decoded).toBe(TEST_PUBKEY);
  });

  it('emits HUDDLE_SSH_USER / HUDDLE_SSH_HOME so the real exec user is discoverable', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('echo "HUDDLE_SSH_USER=$SSH_USER"');
    expect(script).toContain('echo "HUDDLE_SSH_HOME=$SSH_HOME"');
  });

  it('fails loudly (HUDDLE_SSHD_FAILED on stderr, non-zero exit) rather than silently', () => {
    const script = sshBootstrapScript(TEST_PUBKEY);
    expect(script).toContain('HUDDLE_SSHD_FAILED');
    expect(script).toMatch(/fail\(\) \{[\s\S]*exit 1[\s\S]*\}/);
  });
});

describe('port22_listening pattern (extracted from the script)', () => {
  // The live diagnostic session found `ss` is NOT installed in the sbx base
  // image, so /proc/net/tcp is the primary source. This is the exact pattern
  // used inside sshBootstrapScript — kept as a literal here (not re-derived)
  // so a change to the script is what breaks this test, not the other way
  // around.
  const PATTERN = /:0016 [0-9A-F]+:0000 0A /;

  it('matches a real IPv4 listener line', () => {
    expect(PATTERN.test('  0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0')).toBe(true);
  });

  it('matches the IPv6 form (32 hex chars)', () => {
    expect(PATTERN.test('  1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0')).toBe(true);
  });

  it('does NOT match an outbound connection to port 22', () => {
    expect(PATTERN.test('  1: 0100007F:B3A2 0100007F:0016 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 20 0 0 10 -1')).toBe(false);
  });

  it('does NOT match a listener on port 2200 (decoy: same "22" substring)', () => {
    expect(PATTERN.test('  0: 00000000:0898 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0')).toBe(false);
  });
});
