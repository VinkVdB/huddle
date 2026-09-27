// The huddle-mod envelope: its shape, and fail-closed validation of anything
// claiming to be one. Mirrors firewall-group-envelope.ts's structure and
// rationale — deliberately pure (no DB, no filesystem, no audit), so every way
// a mod can enter Huddle (UI authoring, file import, a file in the
// team-managed mods folder) funnels through here first, and the parsing rules
// live in exactly one testable place.
//
// The import/export envelope and the on-disk folder files use the SAME format
// so a mod can move freely between installs, repos and teammates.

export const MOD_ENVELOPE_VERSION = 1;
export const MOD_ENVELOPE_KIND = 'huddle-mod';

export type ModRuntime = 'devcontainer' | 'sbx' | 'both';

export interface ModEnvelope {
  version: number;
  kind: string;
  exported_at?: number;
  mod: {
    id: string;
    name: string;
    description?: string;
    runtime: ModRuntime;
    always_on?: boolean;
    firewall_hint?: string;
  };
  script: string;
}

const ID_RE = /^[a-z0-9-]+$/;
const RUNTIMES = new Set(['devcontainer', 'sbx', 'both']);

// Validate a whole envelope fail-closed. Accepts the versioned `kind` envelope;
// also tolerates a bare `{ id, name, script, ... }` for convenience, the same
// way validateGroupEnvelope tolerates a bare `{ name, rules }`.
export function validateModEnvelope(raw: unknown): ModEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('envelope must be an object');
  const e = raw as Record<string, unknown>;
  const modRaw = (e.mod && typeof e.mod === 'object' && !Array.isArray(e.mod) ? e.mod : e) as Record<string, unknown>;

  const id = typeof modRaw.id === 'string' ? modRaw.id.trim() : '';
  if (!id || !ID_RE.test(id)) {
    throw new Error('mod.id must be a non-empty string matching /^[a-z0-9-]+$/ (lowercase letters, digits, hyphens)');
  }
  const name = typeof modRaw.name === 'string' && modRaw.name.trim() ? modRaw.name.trim() : undefined;
  if (!name) throw new Error('mod.name must be a non-empty string');
  const description = typeof modRaw.description === 'string' ? modRaw.description : '';
  const runtime: ModRuntime =
    typeof modRaw.runtime === 'string' && RUNTIMES.has(modRaw.runtime) ? (modRaw.runtime as ModRuntime) : 'both';
  const always_on = modRaw.always_on === true || modRaw.always_on === 1;
  const firewall_hint = typeof modRaw.firewall_hint === 'string' ? modRaw.firewall_hint : '';

  const script = typeof e.script === 'string' ? e.script : typeof modRaw.script === 'string' ? modRaw.script : undefined;
  if (script === undefined) throw new Error('script must be a string');

  return {
    version: typeof e.version === 'number' ? e.version : MOD_ENVELOPE_VERSION,
    kind: typeof e.kind === 'string' ? e.kind : MOD_ENVELOPE_KIND,
    mod: { id, name, description, runtime, always_on, firewall_hint },
    script,
  };
}

// Serialise an envelope the way the team folder stores it (stable 2-space
// JSON with a trailing newline, so a synced folder stays Git-diff friendly) —
// same idiom as serializeGroupEnvelope.
export function serializeModEnvelope(env: ModEnvelope): string {
  return JSON.stringify(env, null, 2) + '\n';
}
