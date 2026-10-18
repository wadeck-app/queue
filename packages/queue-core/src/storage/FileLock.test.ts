import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileLock, LockLostError } from './FileLock.js';

let dir: string;
let lockPath: string;
let clock: { now: number };
let sleeps: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
  lockPath = join(dir, 'wal.ndjson.lock');
  clock = { now: Date.now() };
  sleeps = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A lock for "process" `pid`, with a fake clock and a fake sleep; `onSleep` lets a test change the world while it waits. */
function lockFor(pid: number, options: { alive?: (pid: number) => boolean; onSleep?: () => void } = {}): FileLock {
  return new FileLock(lockPath, {
    pid,
    staleMs: 5000,
    now: () => clock.now,
    isAlive: options.alive ?? (() => true),
    sleep: (ms) => { sleeps.push(ms); clock.now += ms; options.onSleep?.(); },
  });
}

function writeForeignLock(pid: number | '', ageMs: number): void {
  writeFileSync(lockPath, String(pid));
  const when = new Date(clock.now - ageMs);
  utimesSync(lockPath, when, when);
}

describe('FileLock', () => {
  it('acquire writes our pid into the lock file and release removes the file', () => {
    const lock = lockFor(111);
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('waits with an exponential backoff, capped, while a live process holds a fresh lock, then takes it when released', () => {
    writeForeignLock(222, 0);
    const lock = lockFor(111, { onSleep: () => { if (sleeps.length === 8) rmSync(lockPath); } });
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    expect(sleeps).toEqual([5, 10, 20, 40, 80, 160, 200, 200]);
  });

  it('steals the lock of a process that no longer exists, without waiting', () => {
    writeForeignLock(222, 0);
    const lock = lockFor(111, { alive: (pid) => pid !== 222 });
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    expect(sleeps).toEqual([]);
  });

  it('steals a lock nobody refreshed for staleMs even if its pid looks alive (a hung holder, a reused pid)', () => {
    writeForeignLock(222, 6000);
    const lock = lockFor(111);
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    expect(sleeps).toEqual([]);
  });

  it('gives up waiting 5 seconds after the lock was last modified: waits, then steals', () => {
    writeForeignLock(222, 1000);
    const lock = lockFor(111);
    lock.acquire();
    expect(readFileSync(lockPath, 'utf8')).toBe('111');
    const waited = sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(4000);
    expect(waited).toBeLessThan(4400);
  });

  it('does not treat a lock file that is still being written (empty) as abandoned', () => {
    writeForeignLock('', 0);
    const lock = lockFor(111, { alive: () => false, onSleep: () => { if (sleeps.length === 2) rmSync(lockPath); } });
    lock.acquire();
    expect(sleeps.length).toBe(2);
  });

  it('assertHeld passes while the lock file holds our pid', () => {
    const lock = lockFor(111);
    lock.acquire();
    expect(() => lock.assertHeld()).not.toThrow();
  });

  it('assertHeld throws LockLostError once somebody else took the lock', () => {
    const lock = lockFor(111);
    lock.acquire();
    writeFileSync(lockPath, '222');
    expect(() => lock.assertHeld()).toThrow(LockLostError);
  });

  it('assertHeld throws LockLostError when the lock file is gone', () => {
    const lock = lockFor(111);
    lock.acquire();
    rmSync(lockPath);
    expect(() => lock.assertHeld()).toThrow(LockLostError);
  });

  it('release leaves a lock that now belongs to another process alone', () => {
    const lock = lockFor(111);
    lock.acquire();
    writeFileSync(lockPath, '222');
    lock.release();
    expect(readFileSync(lockPath, 'utf8')).toBe('222');
  });

  it('withLock returns the result and releases', () => {
    const lock = lockFor(111);
    expect(lock.withLock(() => 42)).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('withLock releases when the callback throws, and rethrows', () => {
    const lock = lockFor(111);
    expect(() => lock.withLock(() => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('withLock runs the callback again when the lock was lost before it finished (the callback signals it with assertHeld)', () => {
    const lock = lockFor(111);
    let runs = 0;
    const result = lock.withLock((held) => {
      runs++;
      if (runs === 1) {
        writeFileSync(lockPath, '222');
      }
      held.assertHeld();
      return runs;
    });
    expect(result).toBe(2);
  });

  it('withLock gives up with the LockLostError after 3 lost attempts instead of looping forever', () => {
    const lock = lockFor(111);
    expect(() => lock.withLock((held) => {
      writeFileSync(lockPath, '222');
      held.assertHeld();
    })).toThrow(LockLostError);
  });
});
