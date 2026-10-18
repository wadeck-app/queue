import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * On Windows a file another process is deleting, or has just opened, answers EPERM (or EBUSY/EACCES) instead of
 * ENOENT/EEXIST for a short moment. It showed up as a crashed writer in the multi-process test under load.
 * These errors must mean "try again", with a limit and an actionable message when they persist.
 */
const fail = vi.hoisted(() => ({ read: 0, open: 0, stat: 0, code: 'EPERM' }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const errno = () => Object.assign(new Error(`${fail.code}: simulated`), { code: fail.code });
  return {
    ...real,
    readFileSync: ((...args: Parameters<typeof real.readFileSync>) => {
      if (fail.read > 0) { fail.read--; throw errno(); }
      return real.readFileSync(...args);
    }) as typeof real.readFileSync,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      if (fail.open > 0 && args[1] === 'wx') { fail.open--; throw errno(); }
      return real.openSync(...args);
    }) as typeof real.openSync,
    statSync: ((...args: Parameters<typeof real.statSync>) => {
      if (fail.stat > 0) { fail.stat--; throw errno(); }
      return real.statSync(...args);
    }) as typeof real.statSync,
  };
});

import { FileLock } from './FileLock.js';

let dir: string;
let lockPath: string;
let clock: { now: number };
let sleeps: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-transient-'));
  lockPath = join(dir, 'wal.ndjson.lock');
  clock = { now: Date.now() };
  sleeps = [];
  Object.assign(fail, { read: 0, open: 0, stat: 0, code: 'EPERM' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lockFor(pid: number, onSleep?: () => void): FileLock {
  return new FileLock(lockPath, {
    pid,
    staleMs: 5000,
    now: () => clock.now,
    isAlive: () => true,
    sleep: (ms) => { sleeps.push(ms); clock.now += ms; onSleep?.(); },
  });
}

function writeForeignLock(pid: number): void {
  writeFileSync(lockPath, String(pid));
  const when = new Date(clock.now);
  utimesSync(lockPath, when, when);
}

describe.each(['EPERM', 'EBUSY', 'EACCES'])('FileLock when the lock file answers %s for a moment', (code) => {
  it('retries creating the lock file instead of crashing', () => {
    fail.code = code;
    fail.open = 3;
    const lock = lockFor(111);
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it('retries reading a held lock instead of crashing, then takes it once released', () => {
    fail.code = code;
    writeForeignLock(222);
    fail.read = 2;
    const lock = lockFor(111, () => { if (fail.read === 0 && existsSync(lockPath)) rmSync(lockPath); });
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
  });

  it('retries inspecting a held lock whose stat fails', () => {
    fail.code = code;
    writeForeignLock(222);
    fail.stat = 2;
    const lock = lockFor(111, () => { if (fail.stat === 0 && existsSync(lockPath)) rmSync(lockPath); });
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
  });

  it('assertHeld survives a brief read error on the lock file', () => {
    const lock = lockFor(111);
    lock.acquire();
    fail.code = code;
    fail.read = 2;
    expect(() => lock.assertHeld()).not.toThrow();
  });
});

describe('FileLock when the error does not go away', () => {
  it('gives up after staleMs with a message that names the file, the error and what to do', () => {
    fail.code = 'EPERM';
    fail.open = 1_000_000;
    const lock = lockFor(111);
    expect(() => lock.acquire()).toThrowError(/wal\.ndjson\.lock/);
    expect(() => { fail.open = 1_000_000; lockFor(111).acquire(); }).toThrowError(/EPERM/);
    expect(() => { fail.open = 1_000_000; lockFor(111).acquire(); }).toThrowError(/another process/i);
  });

  it('an error that is not transient still surfaces at once', () => {
    fail.code = 'EIO';
    fail.open = 1;
    expect(() => lockFor(111).acquire()).toThrowError(/EIO/);
  });
});
