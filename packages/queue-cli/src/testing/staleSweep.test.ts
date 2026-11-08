import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALE_AFTER_MS, sweepStaleTestDirs } from './staleSweep.js';

const DAY = STALE_AFTER_MS;
let root: string;
// A fixed "now" far from any real file time: ages are set explicitly with utimes, nothing depends on the clock
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'queue-sweep-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function makeDir(name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'queue.cjs'), 'x');
  const at = new Date(NOW - ageMs);
  utimesSync(dir, at, at);
  return dir;
}

describe('sweepStaleTestDirs', () => {
  it('removes the bundle and app-core directories of a killed run, older than a day', () => {
    const bundle = makeDir('queue-cli-tests-bundle-aB3dE9', DAY + 1000);
    const appCore = makeDir('queue-cli-tests-app-core-Zz09yY', 3 * DAY);
    expect(sweepStaleTestDirs({ root, now: () => NOW }).sort()).toEqual([appCore, bundle].sort());
    expect(existsSync(bundle)).toBe(false);
    expect(existsSync(appCore)).toBe(false);
  });

  it('keeps a directory of a run that may still be going (not older than a day, exactly a day included)', () => {
    const recent = makeDir('queue-cli-tests-bundle-aaaaaa', 60_000);
    const edge = makeDir('queue-cli-tests-bundle-bbbbbb', DAY);
    expect(sweepStaleTestDirs({ root, now: () => NOW })).toEqual([]);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(edge)).toBe(true);
  });

  it('never touches a directory this tool did not create, however old', () => {
    const others = [
      makeDir('queue-cli-tests-bundle-', 5 * DAY),
      makeDir('queue-cli-tests-bundle-aaaaaaa', 5 * DAY),
      makeDir('queue-cli-tests-other-aaaaaa', 5 * DAY),
      makeDir('my-queue-cli-tests-bundle-aaaaaa', 5 * DAY),
      makeDir('queue-cli-tests-bundle-aaaaaa.keep', 5 * DAY),
    ];
    expect(sweepStaleTestDirs({ root, now: () => NOW })).toEqual([]);
    for (const dir of others) {
      expect(existsSync(dir), dir).toBe(true);
    }
  });

  it('does not remove a file that has the name of a directory', () => {
    const file = join(root, 'queue-cli-tests-bundle-aaaaaa');
    writeFileSync(file, 'x');
    const old = new Date(NOW - 5 * DAY);
    utimesSync(file, old, old);
    expect(sweepStaleTestDirs({ root, now: () => NOW })).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it('never follows a link: the target of a link with the name of a stale directory is left alone', () => {
    const target = makeDir('somewhere-else', 5 * DAY);
    const link = join(root, 'queue-cli-tests-bundle-lnk123');
    try {
      symlinkSync(target, link, 'junction');
    } catch (err) {
      throw new Error(`Cannot create a link to test the sweep (${String(err)}): this test needs symbolic links or junctions.`);
    }
    expect(sweepStaleTestDirs({ root, now: () => NOW })).toEqual([]);
    expect(existsSync(join(target, 'queue.cjs'))).toBe(true);
  });

  it('says which directory it could not remove and goes on with the others, instead of staying silent', () => {
    const locked = makeDir('queue-cli-tests-bundle-aaaaaa', 2 * DAY);
    const other = makeDir('queue-cli-tests-app-core-bbbbbb', 2 * DAY);
    const warnings: string[] = [];
    const removed = sweepStaleTestDirs({
      root,
      now: () => NOW,
      remove: (path) => {
        if (path === locked) {
          throw new Error('EBUSY');
        }
        rmSync(path, { recursive: true, force: true });
      },
      warn: (m) => warnings.push(m),
    });
    expect(removed).toEqual([other]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(locked);
    expect(warnings[0]).toContain('EBUSY');
    expect(warnings[0]).toContain('Fix:');
  });
});
