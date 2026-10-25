import { describe, it, expect, vi } from 'vitest';
import { isCalVer, devBuildRefusalMessage } from './devBuildGuard.js';
import { createUpdateScheduler } from './updateScheduler.js';

describe('isCalVer', () => {
  it.each([
    '2026.10.25-020-6cb52900',
    '2026.01.01-001-00000000',
    '2026.12.31-1234-abcdef01',
  ])('accepts the CI release version %s', (v) => {
    expect(isCalVer(v)).toBe(true);
  });

  it.each([
    '0.0.0',
    '0.0.0-dev',
    '0.1.0',
    '0.1.0-dev',
    '0.0.0-test-integration',
    'unbundled-dev',
    'undefined',
    '',
    // local bundler fallback: YYYY.MM.DD-HHMMSS-count-HASH
    '2026.10.25-142530-812-6cb52900',
    // non-padded build number
    '2026.10.25-20-6cb52900',
    // month / day boundaries
    '2026.13.01-020-6cb52900',
    '2026.00.10-020-6cb52900',
    '2026.10.32-020-6cb52900',
    '2026.10.00-020-6cb52900',
    // hash: wrong length, uppercase, non-hex
    '2026.10.25-020-6cb5290',
    '2026.10.25-020-6cb529000',
    '2026.10.25-020-6CB52900',
    '2026.10.25-020-6cb5290g',
    // anything around the version
    ' 2026.10.25-020-6cb52900',
    '2026.10.25-020-6cb52900\n',
    'v2026.10.25-020-6cb52900',
    '2026.10.25-020-6cb52900-dirty',
  ])('rejects the non-release version %j', (v) => {
    expect(isCalVer(v)).toBe(false);
  });

  it('rejects undefined and null', () => {
    expect(isCalVer(undefined)).toBe(false);
    expect(isCalVer(null)).toBe(false);
  });
});

describe('devBuildRefusalMessage', () => {
  it('names the version and the installed binary to use instead', () => {
    const msg = devBuildRefusalMessage('queue', '0.1.0-dev');
    expect(msg).toContain('0.1.0-dev');
    expect(msg).toContain('refusing to update');
    expect(msg).toContain('`queue cli update`');
  });
});

describe('createUpdateScheduler', () => {
  it('never schedules for a dev build', () => {
    const schedule = vi.fn();
    createUpdateScheduler({ version: '0.1.0-dev', schedule })();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('schedules once for a release build, however often it is called', () => {
    const schedule = vi.fn();
    const run = createUpdateScheduler({ version: '2026.10.25-020-6cb52900', schedule });
    run();
    run();
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
