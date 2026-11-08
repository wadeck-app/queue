// The lock that serialises the builds of the test bundle of concurrent vitest runs (see vitest.globalSetup.ts). It is a directory holding owner.json.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const POLL_MS = 250;
// Hang guard only, never a performance limit: a build takes seconds, another run's build can queue ahead of ours
const LOCK_WAIT_MS = 300_000;

export interface BuildLockOptions {
  /** The lock directory. */
  lockDir: string;
  /** Test seam: whether a process exists. */
  isAlive?: (pid: number) => boolean;
  /** Test seam: the pid written as owner. */
  pid?: number;
  /** Test seam: the pause between two attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: called when this contender has just read the owner of the lock (before it decides anything). */
  onOwnerRead?: (owner: number | undefined) => void;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(dir: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { pid?: unknown };
    return typeof owner.pid === 'number' ? owner.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes the lock of a dead owner, one contender at a time. A bare "read the owner, then delete" lets two contenders both see the dead owner: the first deletes
 * and takes the lock, the second then deletes that live lock too and both build. So the removal happens under a second lock directory and the owner is read
 * again there: a lock that was replaced meanwhile has a live owner and stays. Returns false when another contender is deciding right now (retry later).
 * Residual case: a contender that dies inside this few-line section leaves its mutex behind; the next one clears it when its pid is dead, which re-opens the
 * race for that one rare crash only.
 */
function removeStaleLock(lockDir: string, isAlive: (pid: number) => boolean, pid: number): boolean {
  const mutex = `${lockDir}.takeover`;
  try {
    mkdirSync(mutex);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    const holder = readOwner(mutex);
    if (holder !== undefined && !isAlive(holder)) {
      rmSync(mutex, { recursive: true, force: true });
    }
    return false;
  }
  try {
    writeFileSync(join(mutex, 'owner.json'), JSON.stringify({ pid }));
    const current = readOwner(lockDir);
    if (current !== undefined && !isAlive(current)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
    return true;
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
}

/** Waits for the lock and takes it. Throws, naming the lock and its owner, when it stays held for the whole hang guard. */
export async function acquireBuildLock(options: BuildLockOptions): Promise<void> {
  const { lockDir } = options;
  const isAlive = options.isAlive ?? isProcessAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: options.pid ?? process.pid, since: new Date().toISOString() }));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const owner = readOwner(lockDir);
    options.onOwnerRead?.(owner);
    // No owner file yet means the owner is between mkdir and writeFile: give it a moment instead of stealing the lock
    if (owner !== undefined && !isAlive(owner) && removeStaleLock(lockDir, isAlive, options.pid ?? process.pid)) {
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another test run (pid ${owner ?? 'unknown'}) has been building the test bundle for more than ${LOCK_WAIT_MS / 1000} s (lock: ${lockDir}). Fix: stop that run, or delete the lock directory if its owner is gone.`);
    }
    await sleep(POLL_MS);
  }
}

export function releaseBuildLock(lockDir: string): void {
  rmSync(lockDir, { recursive: true, force: true });
}
