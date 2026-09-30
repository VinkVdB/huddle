import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectExtensionFiles, planInstall } from '../src/extension';

let dir: string;

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-cli-ext-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('collectExtensionFiles', () => {
  it('collects every file under the folder with forward-slash names, skipping dotfiles and node_modules', () => {
    // Arrange
    write('manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }));
    write('index.js', 'module.exports.register = () => {};');
    write('frontend/component.js', '');
    write('.DS_Store', '');
    write('node_modules/x/index.js', '');

    // Act
    const { manifest, entries } = collectExtensionFiles(dir);

    // Assert
    expect(manifest).toEqual({ id: 'demo', name: 'Demo', version: '1.0.0' });
    expect(entries.map((e) => e.name).sort()).toEqual(['frontend/component.js', 'index.js', 'manifest.json']);
  });

  it.each([
    ['manifest.json', { 'index.js': '' }],
    ['index.js', { 'manifest.json': JSON.stringify({ id: 'demo', name: 'Demo' }) }],
  ])('refuses a folder without %s', (missing, files) => {
    // Arrange
    for (const [rel, content] of Object.entries(files)) write(rel, content);

    // Act
    const collect = () => collectExtensionFiles(dir);

    // Assert
    expect(collect).toThrow(new RegExp(`${missing} missing`));
  });

  it('refuses a manifest id the gateway would reject', () => {
    // Arrange
    write('manifest.json', JSON.stringify({ id: 'Bad_Id', name: 'Demo' }));
    write('index.js', '');

    // Act
    const collect = () => collectExtensionFiles(dir);

    // Assert
    expect(collect).toThrow(/manifest id/);
  });
});

describe('planInstall', () => {
  const incoming = { id: 'agent-logs', name: 'Agent logs', version: '0.2.0' };

  it('installs when no extension has that id', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'aikido', name: 'Aikido Security', version: '1.0.0' }], false);

    // Assert
    expect(plan).toEqual({ action: 'install' });
  });

  it('updates when the same extension is already installed', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Agent logs', version: '0.1.0' }], false);

    // Assert
    expect(plan).toEqual({ action: 'update', from: '0.1.0' });
  });

  it('refuses when a different extension owns the id', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Someone else', version: '9.0.0' }], false);

    // Assert
    expect(plan.action).toBe('refuse');
    expect(plan).toHaveProperty('reason', expect.stringMatching(/Someone else/));
  });

  it('replaces a different extension with that id only when forced', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Someone else', version: '9.0.0' }], true);

    // Assert
    expect(plan).toEqual({ action: 'update', from: '9.0.0' });
  });
});
