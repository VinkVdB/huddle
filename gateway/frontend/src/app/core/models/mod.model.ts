// A huddle mod (see gateway/src/mods.ts): a named, shareable shell script that
// installs/updates tools or sets up environment stuff inside a devcontainer or
// sbx sandbox at create time. `source` is 'manual' (authored/edited in the UI)
// or 'startup-folder' (loaded from the team-managed mods folder).
export interface Mod {
  id: string;
  name: string;
  description: string;
  script: string;
  runtime: 'devcontainer' | 'sbx' | 'both';
  always_on: number;
  enabled: number;
  firewall_hint: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface ModEnvelope {
  version: number;
  kind: string;
  exported_at?: number;
  mod: {
    id: string;
    name: string;
    description?: string;
    runtime: 'devcontainer' | 'sbx' | 'both';
    always_on?: boolean;
    firewall_hint?: string;
  };
  script: string;
}

export interface ModImportResult {
  mod: Mod;
  imported: number;
  updated: number;
}
