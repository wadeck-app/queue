import { describe, it, expect } from 'vitest';
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
