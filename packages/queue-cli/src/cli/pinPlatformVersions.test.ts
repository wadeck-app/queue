import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../ci/scripts/pin-platform-versions.mjs');

function run(pkg: object, version: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'pin-platform-'));
  const file = join(dir, 'package.json');
  writeFileSync(file, JSON.stringify(pkg));
  const args = version === undefined ? [SCRIPT, file] : [SCRIPT, file, version];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

describe('pin-platform-versions.mjs', () => {
  it('pins every optional dependency to the exact version', () => {
    const { r, out } = run({ name: 'x', optionalDependencies: { a: '>=0.0.0-0', b: '>=0.0.0-0' } }, '2026.10.31-244-cb188647');
    expect(r.status).toBe(0);
    expect(out.optionalDependencies).toEqual({ a: '2026.10.31-244-cb188647', b: '2026.10.31-244-cb188647' });
  });

  it('fails when there is nothing to pin', () => {
    const { r } = run({ name: 'x' }, '1.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no optionalDependencies');
  });

  it('exits 4 without a version', () => {
    const { r } = run({ name: 'x', optionalDependencies: { a: '*' } }, undefined);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('usage');
  });
});
