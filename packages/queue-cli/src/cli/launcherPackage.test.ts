import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLauncherPackage } from './launcherPackage.js';

const V = '2026.10.31-244-cb188647';
const base = { version: V, platform: 'win32', arch: 'x64', resolve: (r: string) => `/g/${r}` };

describe('checkLauncherPackage', () => {
  it('passes when the platform package has the same version', () => {
    const r = checkLauncherPackage({ ...base, readFile: () => JSON.stringify({ version: V }) });
    expect(r.ok).toBe(true);
  });

  it('fails loudly with the fix command when the platform package is stale', () => {
    const r = checkLauncherPackage({ ...base, readFile: () => JSON.stringify({ version: '2026.10.27-239-94afc5f7' }) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('stale');
    expect(r.detail).toContain(`npm install -g @wadeck-app/queue-cli-win32-x64@${V}`);
  });

  it('fails when the platform package is missing', () => {
    const r = checkLauncherPackage({ ...base, resolve: () => { throw new Error('Cannot find module'); } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Cannot find module');
    expect(r.detail).toContain('npm install -g');
  });

  it('fails when the package.json has no version', () => {
    const r = checkLauncherPackage({ ...base, readFile: () => '{}' });
    expect(r.ok).toBe(false);
  });

  it('is skipped (explicitly) for dev builds', () => {
    const r = checkLauncherPackage({ ...base, version: '0.1.0-dev', resolve: () => { throw new Error('x'); } });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('skipped');
  });

  it('uses the darwin-arm64 package on arm64', () => {
    const r = checkLauncherPackage({ ...base, platform: 'darwin', arch: 'arm64', readFile: () => JSON.stringify({ version: '1.0.0-x' }) });
    expect(r.detail).toContain('queue-cli-darwin-arm64');
  });
});

describe('checkLauncherPackage shadowed copy warning', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  // Layout: <tmp>/@wadeck-app/queue-cli/<private>/@wadeck-app/queue-cli-win32-x64 (nested copy, right version, found by resolve)
  // and optionally <tmp>/@wadeck-app/queue-cli-win32-x64 (top-level sibling).
  function layout(siblingVersion?: string, scopeName = '@wadeck-app') {
    const root = mkdtempSync(join(tmpdir(), 'launcher-shadow-'));
    dirs.push(root);
    const scope = join(root, scopeName);
    const cli = join(scope, 'queue-cli');
    const nested = join(cli, 'private', '@wadeck-app', 'queue-cli-win32-x64');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ version: V }));
    const sibling = join(scope, 'queue-cli-win32-x64');
    if (siblingVersion !== undefined) {
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'package.json'), JSON.stringify({ version: siblingVersion }));
    }
    return { cli, sibling, nested };
  }

  it('warns (still ok) with both paths and the cleanup command for a stale top-level copy', () => {
    const l = layout('2026.10.27-239-94afc5f7');
    const r = checkLauncherPackage({ ...base, resolve: () => join(l.nested, 'package.json'), packageDir: l.cli });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings![0]).toContain(l.sibling);
    expect(r.warnings![0]).toContain(l.cli);
    expect(r.warnings![0]).toContain('2026.10.27-239-94afc5f7');
    expect(r.warnings![0]).toContain('npm uninstall -g @wadeck-app/queue-cli-win32-x64');
  });

  it('does not warn when there is no top-level copy', () => {
    const l = layout();
    const r = checkLauncherPackage({ ...base, resolve: () => join(l.nested, 'package.json'), packageDir: l.cli });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it('does not warn when the top-level copy has the same version', () => {
    const l = layout(V);
    const r = checkLauncherPackage({ ...base, resolve: () => join(l.nested, 'package.json'), packageDir: l.cli });
    expect(r.warnings).toBeUndefined();
  });

  it('does not warn when queue-cli is not inside an @wadeck-app directory', () => {
    const l = layout('2026.10.27-239-94afc5f7', 'other-scope');
    const r = checkLauncherPackage({ ...base, resolve: () => join(l.nested, 'package.json'), packageDir: l.cli });
    expect(r.warnings).toBeUndefined();
  });

  it('skips explicitly for dev builds even with a stale copy', () => {
    const l = layout('2026.10.27-239-94afc5f7');
    const r = checkLauncherPackage({ ...base, version: '0.1.0-dev', packageDir: l.cli });
    expect(r.detail).toContain('skipped');
    expect(r.warnings).toBeUndefined();
  });
});
