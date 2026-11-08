import { describe, expect, it } from 'vitest';
import { goBuildEnv } from './goBuildEnv.js';

describe('goBuildEnv - the environment of a Go build started by a test', () => {
  it('has no TMPDIR: build.sh assigns TMPDIR=$(mktemp -d), which changes an EXPORTED TMPDIR for go and makes go ignore the go.mod it just copied there', () => {
    const env = goBuildEnv({ TMPDIR: '/tmp/qrun-abc', PATH: '/bin' }, undefined);
    expect('TMPDIR' in env).toBe(false);
    expect(env['PATH']).toBe('/bin');
  });

  it('removes TMPDIR whatever its case (Windows environments are case-insensitive)', () => {
    const env = goBuildEnv({ Tmpdir: '/x', tmpdir: '/y', KEEP: '1' }, undefined);
    expect(Object.keys(env)).toEqual(['KEEP']);
  });

  it('points TEMP and TMP to the real temp dir when the leak guard gave one (the Windows spelling of the temp dir)', () => {
    const env = goBuildEnv({ TEMP: '/qrun', TMP: '/qrun', TMPDIR: '/qrun' }, '/real/tmp');
    expect(env['TEMP']).toBe('/real/tmp');
    expect(env['TMP']).toBe('/real/tmp');
    expect('TMPDIR' in env).toBe(false);
  });

  it('leaves TEMP and TMP alone outside the leak guard', () => {
    const env = goBuildEnv({ TEMP: '/t', TMP: '/m' }, undefined);
    expect(env['TEMP']).toBe('/t');
    expect(env['TMP']).toBe('/m');
  });

  it('does not change the environment it was given', () => {
    const base = { TMPDIR: '/q', TEMP: '/q' };
    goBuildEnv(base, '/real');
    expect(base).toEqual({ TMPDIR: '/q', TEMP: '/q' });
  });
});
