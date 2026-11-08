import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBuildLock, isProcessAlive, releaseBuildLock } from './buildLock.js';

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

// A pause that fails the test instead of looping when the lock is never obtained (a mutation that stops the progress must fail fast, not hang)
function pausing(onPause: () => void = () => undefined, limit = 5): () => Promise<void> {
  let n = 0;
  return () => {
    if (++n > limit) {
      return Promise.reject(new Error(`still waiting for the lock after ${limit} pauses`));
    }
    onPause();
    return Promise.resolve();
  };
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
        rmSync(lockDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('gives up with an error naming the owner and the lock once the hang guard is over (not a moment before)', async () => {
    writeOwner(ALIVE);
    const clock = [0, 300_000, 300_001];
    let sleeps = 0;
    const failure = await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      now: () => clock.shift() ?? Number.MAX_SAFE_INTEGER,
      sleep: pausing(() => sleeps++),
    }).then(() => undefined, (err: Error) => err);
    expect(failure?.message).toContain(`pid ${ALIVE}`);
    expect(failure?.message).toContain('300 s');
    expect(failure?.message).toContain(lockDir);
    // Waited at exactly the limit, gave up one millisecond later
    expect(sleeps).toBe(1);
    expect(ownerOf()).toBe(ALIVE);
  });

  it('clears the takeover mutex of a contender that died, then takes the lock of the dead owner', async () => {
    writeOwner(DEAD);
    const mutex = `${lockDir}.takeover`;
    mkdirSync(mutex);
    writeFileSync(join(mutex, 'owner.json'), JSON.stringify({ pid: DEAD }));
    let sleeps = 0;
    await acquireBuildLock({ lockDir, pid: 7, isAlive, sleep: pausing(() => sleeps++) });
    // The first attempt only cleared the dead contender's mutex; the second took over
    expect(sleeps).toBe(1);
    expect(ownerOf()).toBe(7);
    expect(existsSync(mutex)).toBe(false);
  });

  it('leaves the takeover mutex of a live contender alone and waits', async () => {
    writeOwner(DEAD);
    const mutex = `${lockDir}.takeover`;
    mkdirSync(mutex);
    writeFileSync(join(mutex, 'owner.json'), JSON.stringify({ pid: ALIVE }));
    let mutexAtPause: boolean | undefined;
    await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      sleep: pausing(() => {
        mutexAtPause = existsSync(mutex);
        rmSync(mutex, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }),
    });
    expect(mutexAtPause).toBe(true);
    expect(ownerOf()).toBe(7);
  });

  it('does not treat a mutex without an owner file as abandoned (its creator is between mkdir and write)', async () => {
    writeOwner(DEAD);
    const mutex = `${lockDir}.takeover`;
    mkdirSync(mutex);
    let mutexAtPause: boolean | undefined;
    await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      sleep: pausing(() => {
        mutexAtPause = existsSync(mutex);
        rmSync(mutex, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }),
    });
    expect(mutexAtPause).toBe(true);
  });

  it('removes its own mutex when the lock turns out to be live', async () => {
    writeOwner(ALIVE);
    let mutexAtPause: boolean | undefined;
    await acquireBuildLock({
      lockDir,
      pid: 7,
      isAlive,
      sleep: pausing(() => {
        mutexAtPause = existsSync(`${lockDir}.takeover`);
        releaseBuildLock(lockDir);
      }),
    });
    expect(mutexAtPause).toBe(false);
  });
});

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const killFails = (code: string): void => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
  };

  it('is true when the signal 0 is delivered', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isProcessAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it('counts a process owned by someone else (EPERM) as alive', () => {
    killFails('EPERM');
    expect(isProcessAlive(4242)).toBe(true);
  });

  it('is false when the process does not exist (ESRCH)', () => {
    killFails('ESRCH');
    expect(isProcessAlive(4242)).toBe(false);
  });
});
