import { renameSync } from 'node:fs';

// On Windows, replacing a file another process (or a scanner) has open for a moment answers one of these instead of succeeding;
// measured: EPERM from Wal.commit under CPU load, 1 run in ~50, never with the same inputs a second later.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ATTEMPTS = 40;
const PAUSE_MS = 25;

export interface AtomicRenameOptions {
  /** Test seam: the real rename. */
  rename?: (from: string, to: string) => void;
  /** Test seam: blocking sleep (the storage classes are synchronous). */
  sleep?: (ms: number) => void;
  attempts?: number;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomically replaces `to` by `from`, retrying a short while when the OS says the target is busy (EPERM, EBUSY, EACCES).
 * Anything else, and a busy target that stays busy, throws with the paths and what to check.
 */
export function renameReplacing(from: string, to: string, options: AtomicRenameOptions = {}): void {
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? blockingSleep;
  const attempts = options.attempts ?? ATTEMPTS;
  let last: NodeJS.ErrnoException | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_CODES.has(code)) {
        throw err;
      }
      last = err as NodeJS.ErrnoException;
      if (attempt < attempts) {
        sleep(PAUSE_MS);
      }
    }
  }
  throw new Error(
    `Could not replace ${to}: ${last?.code} on rename from ${from} after ${attempts} attempts (${attempts * PAUSE_MS} ms). ` +
      `Another program keeps the file open (antivirus, indexer, an editor); close it or exclude the queue config directory from its scan, then retry.`,
    { cause: last },
  );
}
