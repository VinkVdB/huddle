import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { Mod } from '../../core/models/mod.model';
import { IconComponent } from '../../shared/components/icon/icon.component';

// The Mods page (see gateway/src/mods.ts): a shared, named library of shell
// scripts that install/update tools or set up environment stuff, run at
// devcontainer/sbx create time — root, same trust tier as Huddle's own
// install-ide.sh step (see mods.ts's header comment for the full rationale).
// Deliberately reuses no firewall bypass: a mod's `firewall_hint` is shown
// so an operator knows which firewall group(s) to enable, but nothing here
// grants network access on its own.
@Component({
  selector: 'app-mods',
  standalone: true,
  imports: [FormsModule, RouterLink, IconComponent],
  template: `
    <div class="page-header">
      <h1>Mods</h1>
      <div class="mods__actions">
        <button type="button" class="btn btn-ghost" (click)="importInput.click()"><app-icon name="upload" [size]="15" /> Import</button>
        <button type="button" class="btn btn-ghost" [disabled]="syncing()" (click)="syncToFolder()"><app-icon name="refresh" [size]="15" /> {{ syncing() ? 'Syncing…' : 'Sync to folder' }}</button>
        <button type="button" class="btn btn--accent" (click)="startCreate()"><app-icon name="plus" [size]="15" /> New mod</button>
        <input #importInput type="file" accept="application/json,.json" hidden (change)="onImportFile($event)" />
      </div>
    </div>

    <p class="mods__hint">
      Shared, reviewable scripts that install or update tools, or set up environment
      stuff, when a devcontainer or sandbox is created — no image rebuild needed.
      They run as root, the same trust level as Huddle's own IDE-backend installer,
      so treat a mod's script like you would a change to the base image. A mod never
      opens firewall access on its own — use the optional "Firewall hint" to note
      which firewall group(s) it needs, and enable those separately on the
      <a routerLink="/firewall">Firewall page</a>.
    </p>

    @if (note()) { <div class="mods__note">{{ note() }}</div> }

    <div class="card mods__body">
      <aside class="mods__list">
        @for (m of mods(); track m.id) {
          <button type="button" class="mods__item" [class.on]="selectedId() === m.id" (click)="select(m.id)">
            <span class="mods__item-main">
              <span class="mods__item-name">{{ m.name }}</span>
              <span class="mods__item-badges">
                @if (m.always_on) { <span class="pill pill--on">Always on</span> }
                @if (!m.enabled) { <span class="pill pill--off">Disabled</span> }
                @if (m.source === 'startup-folder') { <span class="pill pill--folder">From folder</span> }
              </span>
            </span>
            <span class="mods__item-runtime">{{ runtimeLabel(m.runtime) }}</span>
          </button>
        } @empty {
          <p class="mods__empty">No mods yet. Create one, or import a shared mod file.</p>
        }
      </aside>

      <div class="mods__detail">
        @if (creating()) {
          <form class="mods__form" (ngSubmit)="submitCreate()">
            <h3>New mod</h3>
            <label class="mods__row">
              <span>Id</span>
              <input [(ngModel)]="form.id" name="id" placeholder="rustup" autocomplete="off" pattern="[a-z0-9-]+" required />
            </label>
            <label class="mods__row">
              <span>Name</span>
              <input [(ngModel)]="form.name" name="name" placeholder="Rustup" autocomplete="off" required />
            </label>
            <label class="mods__row">
              <span>Description</span>
              <textarea [(ngModel)]="form.description" name="description" rows="2" placeholder="What this mod installs or sets up"></textarea>
            </label>
            <div class="mods__row-inline">
              <label class="mods__row">
                <span>Runs on</span>
                <select [(ngModel)]="form.runtime" name="runtime">
                  <option value="both">Devcontainers &amp; sandboxes</option>
                  <option value="devcontainer">Devcontainers only</option>
                  <option value="sbx">Sandboxes only</option>
                </select>
              </label>
              <label class="mods__check"><input type="checkbox" [(ngModel)]="form.always_on" name="always_on" /> Always on (applied to every new workspace)</label>
            </div>
            <label class="mods__row">
              <span>Firewall hint (optional)</span>
              <input [(ngModel)]="form.firewall_hint" name="firewall_hint" placeholder="e.g. rustup.rs, static.rust-lang.org" autocomplete="off" />
            </label>
            <label class="mods__row">
              <span>Script (runs as root, sh)</span>
              <textarea class="mods__script" [(ngModel)]="form.script" name="script" rows="10" placeholder="curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" required></textarea>
            </label>
            <div class="mods__form-actions">
              <button type="submit" class="btn btn--accent btn--sm" [disabled]="!canSubmitCreate() || saving()">{{ saving() ? 'Creating…' : 'Create mod' }}</button>
              <button type="button" class="btn btn-ghost btn--sm" (click)="cancelCreate()">Cancel</button>
            </div>
          </form>
        } @else if (selected()) {
          <form class="mods__form" (ngSubmit)="saveEdit()">
            <div class="mods__form-head">
              <h3>{{ selected()!.name }}</h3>
              @if (selected()!.source === 'startup-folder') {
                <p class="mods__folder-hint">This mod comes from the team-managed folder. Use "Sync to folder" after saving, or the next reload puts the file's contents back.</p>
              }
            </div>
            <label class="mods__row">
              <span>Name</span>
              <input [(ngModel)]="form.name" name="editName" autocomplete="off" required />
            </label>
            <label class="mods__row">
              <span>Description</span>
              <textarea [(ngModel)]="form.description" name="editDescription" rows="2"></textarea>
            </label>
            <div class="mods__row-inline">
              <label class="mods__row">
                <span>Runs on</span>
                <select [(ngModel)]="form.runtime" name="editRuntime">
                  <option value="both">Devcontainers &amp; sandboxes</option>
                  <option value="devcontainer">Devcontainers only</option>
                  <option value="sbx">Sandboxes only</option>
                </select>
              </label>
              <label class="mods__check"><input type="checkbox" [(ngModel)]="form.always_on" name="editAlwaysOn" /> Always on</label>
              <label class="mods__check"><input type="checkbox" [(ngModel)]="form.enabled" name="editEnabled" /> Enabled</label>
            </div>
            <label class="mods__row">
              <span>Firewall hint (optional)</span>
              <input [(ngModel)]="form.firewall_hint" name="editFirewallHint" autocomplete="off" />
            </label>
            <label class="mods__row">
              <span>Script (runs as root, sh)</span>
              <textarea class="mods__script" [(ngModel)]="form.script" name="editScript" rows="10" required></textarea>
            </label>
            <div class="mods__form-actions">
              <button type="submit" class="btn btn--accent btn--sm" [disabled]="!canSubmitEdit() || saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
              <button type="button" class="btn btn-ghost btn--sm" (click)="exportMod(selected()!)"><app-icon name="download" [size]="13" /> Export</button>
              <button type="button" class="btn btn-ghost btn--sm mods__del" (click)="deleteMod(selected()!)"><app-icon name="trash" [size]="13" /> Delete</button>
            </div>
          </form>
        } @else {
          <p class="mods__empty">Select a mod on the left, or create a new one.</p>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .mods__actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .mods__hint { color: var(--text-muted); font-size: 0.88em; margin: 8px 0 18px; max-width: 900px; }
    .mods__hint a { color: var(--accent); }
    .mods__note { margin: 0 0 12px; font-size: 0.85em; color: var(--text-muted); }

    .mods__body { display: grid; grid-template-columns: 280px 1fr; gap: 20px; }
    .mods__list { display: flex; flex-direction: column; gap: 4px; border-right: 1px solid var(--border); padding-right: 16px; }
    .mods__item { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 9px 12px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--text); text-align: left; }
    .mods__item:hover { background: var(--surface-hover); }
    .mods__item.on { background: var(--accent-soft); color: var(--accent-strong); }
    .mods__item-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mods__item-name { font-weight: 600; font-size: 0.92em; }
    .mods__item-badges { display: flex; gap: 4px; flex-wrap: wrap; }
    .mods__item-runtime { font-size: 0.76em; color: var(--text-dim); }
    .mods__empty { color: var(--text-muted); font-size: 0.88em; padding: 8px 0; }

    .pill { font-size: 0.68em; font-weight: 700; letter-spacing: .02em; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; }
    .pill--on { background: var(--accent-soft); color: var(--accent-strong); }
    .pill--off { background: var(--danger-soft, rgba(224,108,117,.15)); color: var(--danger); }
    .pill--folder { background: var(--info-soft); color: var(--info); }

    .mods__form { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
    .mods__form h3 { margin: 0; }
    .mods__folder-hint { margin: 0; font-size: 0.8em; color: var(--text-dim); }
    .mods__row { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em; color: var(--text-muted); }
    .mods__row input, .mods__row select, .mods__row textarea { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); font: inherit; resize: vertical; }
    .mods__row-inline { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    .mods__check { display: flex; align-items: center; gap: 6px; font-size: 0.85em; color: var(--text-muted); white-space: nowrap; }
    .mods__script { font-family: 'Space Grotesk', monospace; font-size: 0.85em; }
    .mods__form-actions { display: flex; gap: 6px; }
    .mods__del:hover { border-color: var(--danger); color: var(--danger); }

    .btn-ghost { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; }
    .btn-ghost:hover { background: var(--surface-hover); }
    .btn-ghost:disabled { opacity: .5; cursor: default; }
    .btn--sm { padding: 5px 10px; font-size: 0.8em; }
  `],
})
export class ModsComponent implements OnInit {
  private api = inject(ApiService);

  mods = signal<Mod[]>([]);
  selectedId = signal<string | null>(null);
  creating = signal(false);
  saving = signal(false);
  syncing = signal(false);
  note = signal<string | null>(null);

  form = {
    id: '',
    name: '',
    description: '',
    runtime: 'both' as 'devcontainer' | 'sbx' | 'both',
    always_on: false,
    enabled: true,
    firewall_hint: '',
    script: '',
  };

  selected = computed(() => this.mods().find((m) => m.id === this.selectedId()) ?? null);

  ngOnInit(): void {
    this.loadMods();
  }

  private loadMods(): void {
    this.api.getMods().subscribe({ next: (ms) => this.mods.set(ms), error: (e) => this.note.set(e.message) });
  }

  runtimeLabel(runtime: string): string {
    if (runtime === 'devcontainer') return 'Devcontainers';
    if (runtime === 'sbx') return 'Sandboxes';
    return 'Devcontainers & sandboxes';
  }

  private resetForm(): void {
    this.form = { id: '', name: '', description: '', runtime: 'both', always_on: false, enabled: true, firewall_hint: '', script: '' };
  }

  select(id: string): void {
    this.creating.set(false);
    this.selectedId.set(id);
    const m = this.mods().find((x) => x.id === id);
    if (!m) return;
    this.form = {
      id: m.id, name: m.name, description: m.description, runtime: m.runtime,
      always_on: m.always_on === 1, enabled: m.enabled === 1, firewall_hint: m.firewall_hint, script: m.script,
    };
  }

  startCreate(): void { this.creating.set(true); this.selectedId.set(null); this.resetForm(); }
  cancelCreate(): void { this.creating.set(false); this.resetForm(); }

  canSubmitCreate(): boolean {
    return /^[a-z0-9-]+$/.test(this.form.id.trim()) && !!this.form.name.trim() && !!this.form.script.trim();
  }
  canSubmitEdit(): boolean {
    return !!this.form.name.trim() && !!this.form.script.trim();
  }

  submitCreate(): void {
    if (!this.canSubmitCreate() || this.saving()) return;
    this.saving.set(true);
    this.api.createMod({
      id: this.form.id.trim(),
      name: this.form.name.trim(),
      description: this.form.description.trim(),
      script: this.form.script,
      runtime: this.form.runtime,
      always_on: this.form.always_on,
      firewall_hint: this.form.firewall_hint.trim(),
    }).subscribe({
      next: (m) => {
        this.saving.set(false);
        this.creating.set(false);
        this.note.set(`Created mod "${m.name}"`);
        this.loadMods();
        this.select(m.id);
      },
      error: (e) => { this.saving.set(false); this.note.set(e.message); },
    });
  }

  saveEdit(): void {
    const m = this.selected();
    if (!m || !this.canSubmitEdit() || this.saving()) return;
    this.saving.set(true);
    this.api.updateMod(m.id, {
      name: this.form.name.trim(),
      description: this.form.description.trim(),
      script: this.form.script,
      runtime: this.form.runtime,
      always_on: this.form.always_on,
      enabled: this.form.enabled,
      firewall_hint: this.form.firewall_hint.trim(),
    }).subscribe({
      next: () => { this.saving.set(false); this.note.set(`Saved "${this.form.name.trim()}"`); this.loadMods(); },
      error: (e) => { this.saving.set(false); this.note.set(e.message); },
    });
  }

  deleteMod(m: Mod): void {
    if (!confirm(`Delete mod "${m.name}"? This does not affect containers/sandboxes it already ran in.`)) return;
    this.api.deleteMod(m.id).subscribe({
      next: () => { this.note.set(`Deleted "${m.name}"`); this.selectedId.set(null); this.loadMods(); },
      error: (e) => this.note.set(e.message),
    });
  }

  exportMod(m: Mod): void {
    this.api.exportMod(m.id).subscribe({
      next: (doc) => {
        this.download(doc, `huddle-mod-${m.id}.json`);
        this.note.set(`Exported "${m.name}"`);
      },
      error: (e) => this.note.set(e.message),
    });
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let doc: unknown;
      try { doc = JSON.parse(String(reader.result)); }
      catch { this.note.set('Import failed: not valid JSON'); return; }
      this.api.importMod(doc).subscribe({
        next: (res) => {
          this.note.set(res.imported ? `Imported mod "${res.mod.name}"` : `Updated mod "${res.mod.name}"`);
          this.loadMods();
          this.select(res.mod.id);
        },
        error: (e) => this.note.set('Import failed: ' + e.message),
      });
    };
    reader.readAsText(file);
  }

  syncToFolder(): void {
    this.syncing.set(true);
    this.api.syncModsFolder().subscribe({
      next: (r) => {
        this.syncing.set(false);
        if (!r.mounted) {
          this.note.set('No mods folder mounted — set one in Settings and run `huddle restart`.');
          return;
        }
        if (r.written === 0 && r.errors.length > 0) {
          this.note.set('Could not write to the folder — it may still be mounted read-only. Run `huddle restart` to remount it writable.');
          return;
        }
        const parts = [`Synced ${r.written} mod(s) to the folder`];
        if (r.pruned > 0) parts.push(`${r.pruned} stale file(s) removed`);
        if (r.errors.length > 0) parts.push(`${r.errors.length} error(s)`);
        this.note.set(parts.join(' · '));
        this.loadMods();
      },
      error: (e) => { this.syncing.set(false); this.note.set('Sync failed: ' + e.message); },
    });
  }

  private download(doc: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
}
