import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBuildLock, releaseBuildLock } from './buildLock.js';

const DEAD = 111;
const ALIVE = 222;
const isAlive = (pid: number): boolean => pid === ALIVE;

let root: string;
let lockDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'queue-buildlock-test-'));
  lockDir = join(root, 'bundle.lock');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function writeOwner(pid: number): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid }));
}

const ownerOf = (): number => (JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as { pid: number }).pid;

describe('acquireBuildLock', () => {
  it('takes a free lock and writes its pid; release removes it', async () => {
    await acquireBuildLock({ lockDir, pid: 7, isAlive });
    expect(ownerOf()).toBe(7);
    releaseBuildLock(lockDir);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('takes over a lock whose owner is gone', async () => {
    writeOwner(DEAD);
    await acquireBuildLock({ lockDir, pid: 7, isAlive });
    expect(ownerOf()).toBe(7);
  });

  it('waits for a lock whose owner is alive, until that owner releases it', async () => {
    writeOwner(ALIVE);
    let sleeps = 0;
    await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      sleep: () => {
        sleeps++;
        releaseBuildLock(lockDir);
        return Promise.resolve();
      },
    });
    expect(sleeps).toBe(1);
    expect(ownerOf()).toBe(7);
  });

  it('does not steal a lock that a faster contender took over while this one was deciding (two stale-lock takeovers must not both build)', async () => {
    writeOwner(DEAD);
    const events: string[] = [];
    let contenderSeen = false;
    await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      // This contender has read the dead owner; before it acts, another run replaces the stale lock by its own, live one
      onOwnerRead: () => {
        if (contenderSeen) return;
        contenderSeen = true;
        rmSync(lockDir, { recursive: true, force: true });
        writeOwner(ALIVE);
        events.push('other run holds the lock');
      },
      sleep: () => {
        events.push('other run releases the lock');
        releaseBuildLock(lockDir);
        return Promise.resolve();
      },
    });
    events.push('this run holds the lock');
    expect(events).toEqual(['other run holds the lock', 'other run releases the lock', 'this run holds the lock']);
    expect(ownerOf()).toBe(7);
  });
});
