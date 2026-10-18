import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAppModuleVersion, registerAfterUpdate } from './registerAfterUpdate.js';

let installDir: string;
let manifestPath: string;
const register = vi.fn();
let lines: string[];
const log = (line: string): void => { lines.push(line); };

function writeManifest(content: string): void {
  mkdirSync(join(installDir, 'app-module'), { recursive: true });
  writeFileSync(manifestPath, content);
}

beforeEach(() => {
  installDir = mkdtempSync(join(tmpdir(), 'register-after-update-'));
  manifestPath = join(installDir, 'app-module', 'manifest.json');
  lines = [];
  register.mockReset();
  register.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(installDir, { recursive: true, force: true });
});

describe('readAppModuleVersion', () => {
  it('returns the version written in the manifest', () => {
    writeManifest(JSON.stringify({ version: '2026.10.18-131-abc' }));
    expect(readAppModuleVersion(manifestPath)).toEqual({ version: '2026.10.18-131-abc' });
  });

  it('reports a missing manifest as absent, not as an error (an older install has no app-module)', () => {
    expect(readAppModuleVersion(manifestPath)).toEqual({ absent: true });
  });

  it('reports an unreadable manifest with the reason', () => {
    writeManifest('{not json');
    expect(readAppModuleVersion(manifestPath)).toMatchObject({ error: expect.stringContaining('manifest.json') });
  });
});

describe('registerAfterUpdate', () => {
  it('registers when the installed app-module version changed during the update', async () => {
    writeManifest(JSON.stringify({ version: '2' }));
    await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe(manifestPath);
  });

  it('registers when the install gained an app-module it did not have before', async () => {
    writeManifest(JSON.stringify({ version: '1' }));
    await registerAfterUpdate({ manifestPath, before: { absent: true }, register, log });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and says nothing, when the version did not change (already up to date)', async () => {
    writeManifest(JSON.stringify({ version: '1' }));
    await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('says nothing when there is no app-module before or after (nothing to register)', async () => {
    await registerAfterUpdate({ manifestPath, before: { absent: true }, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('warns when the app-module disappeared from the install', async () => {
    await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('no longer');
  });

  it('warns, with the reason, when the new manifest cannot be read', async () => {
    writeManifest('{not json');
    await registerAfterUpdate({ manifestPath, before: { version: '1' }, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('manifest.json');
  });
});
