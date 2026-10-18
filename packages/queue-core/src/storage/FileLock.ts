import { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The lock was taken over (or deleted) while we held it: what we were about to write may clash with another writer. */
export class LockLostError extends Error {
  constructor(lockPath: string, pid: number) {
    super(`Lock ${lockPath} is no longer held by process ${pid}; another process took it over.`);
    this.name = 'LockLostError';
  }
}

export interface FileLockOptions {
  /** Identity written into the lock file. Default: this process. */
  pid?: number;
  /** A lock not modified for this long is considered abandoned, whatever its pid says. Default 5000. */
  staleMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  /** Blocking sleep (the storage classes are synchronous). */
  sleep?: (ms: number) => void;
}

const FIRST_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 200;
const MAX_LOST_ATTEMPTS = 3;

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Cross-process mutual exclusion for the queue's read-modify-write files (wal.ndjson, dlq.ndjson).
 * The lock is a file created exclusively ('wx') that holds its owner's pid. A writer may touch the data file
 * only while the lock file holds ITS pid. Others retry with an exponential backoff; a lock is taken over when
 * its owner no longer exists, or when nobody modified it for `staleMs` (a hung or crashed holder).
 * Writes are rare and critical sections short, so contention is low; readers never lock (data files are replaced
 * atomically by rename).
 *
 * Takeover is not perfectly atomic: a writer that was wrongly robbed notices through `assertHeld()`, which it must
 * call right before committing, and `withLock` then runs its callback again on fresh data.
 */
export class FileLock {
  private readonly pid: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => void;

  constructor(private readonly lockPath: string, options: FileLockOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.staleMs = options.staleMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.sleep = options.sleep ?? blockingSleep;
  }

  acquire(): void {
    let delay = FIRST_BACKOFF_MS;
    for (;;) {
      if (this.tryCreate()) {
        return;
      }
      const holder = this.inspect();
      if (holder === null) {
        continue;
      }
      if (this.isAbandoned(holder)) {
        this.takeOver();
        continue;
      }
      this.sleep(delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }

  release(): void {
    if (this.readOwner() === this.pid) {
      try {
        unlinkSync(this.lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  /** Throws LockLostError unless the lock file still holds our pid. Call it right before committing a write. */
  assertHeld(): void {
    if (this.readOwner() !== this.pid) {
      throw new LockLostError(this.lockPath, this.pid);
    }
  }

  /**
   * Runs `fn` while holding the lock. If `fn` reports the lock was lost (assertHeld), it runs again, up to 3 times,
   * so that it re-reads the data another writer may have changed.
   */
  withLock<T>(fn: (held: FileLock) => T): T {
    for (let attempt = 1; ; attempt++) {
      this.acquire();
      try {
        return fn(this);
      } catch (err) {
        if (!(err instanceof LockLostError) || attempt >= MAX_LOST_ATTEMPTS) {
          throw err;
        }
      } finally {
        this.release();
      }
    }
  }

  private tryCreate(): boolean {
    for (let retriedAfterMkdir = false; ; retriedAfterMkdir = true) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try {
          writeSync(fd, String(this.pid));
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          return false;
        }
        if (code === 'ENOENT' && !retriedAfterMkdir) {
          mkdirSync(dirname(this.lockPath), { recursive: true });
          continue;
        }
        throw err;
      }
    }
  }

  /** Who holds the lock and since when; null when the file vanished meanwhile; pid undefined while it is being written. */
  private inspect(): { pid: number | undefined; mtimeMs: number } | null {
    try {
      const mtimeMs = statSync(this.lockPath).mtimeMs;
      const pid = Number.parseInt(readFileSync(this.lockPath, 'utf8'), 10);
      return { pid: Number.isNaN(pid) ? undefined : pid, mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  private isAbandoned(holder: { pid: number | undefined; mtimeMs: number }): boolean {
    if (this.now() - holder.mtimeMs > this.staleMs) {
      return true;
    }
    return holder.pid !== undefined && !this.isAlive(holder.pid);
  }

  /** Renaming is atomic: of several processes taking over the same stale lock, one rename succeeds, the others see ENOENT. */
  private takeOver(): void {
    const graveyard = `${this.lockPath}.stale-${this.pid}-${this.now()}`;
    try {
      renameSync(this.lockPath, graveyard);
      unlinkSync(graveyard);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  private readOwner(): number | undefined {
    try {
      const pid = Number.parseInt(readFileSync(this.lockPath, 'utf8'), 10);
      return Number.isNaN(pid) ? undefined : pid;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }
}
