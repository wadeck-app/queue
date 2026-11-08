import { accessSync, closeSync, constants, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// On Windows, replacing a file another process (or a scanner) has open for a moment answers one of these instead of succeeding;
// measured: EPERM from Wal.commit under CPU load, 1 run in ~50, never with the same inputs a second later.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// EBUSY is always a lock. EPERM and EACCES are a lock only while the file could be written: for a read-only file or a denied directory they never go away
const ALWAYS_TRANSIENT = 'EBUSY';
const PAUSE_MS = 25;
// The wait is a blocking Atomics.wait (the storage classes are synchronous), so it stalls the whole daemon event loop, and Wal.append runs once per subscriber:
// the total time slept stays under this, (attempts - 1) * PAUSE_MS
const MAX_BLOCK_MS = 1000;
const ATTEMPTS = MAX_BLOCK_MS / PAUSE_MS;

/** Test seam of {@link writeFileDurably}: the file system calls it makes. */
export interface DurableWriteFs {
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, text: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

/**
 * Writes `content` to `path` and flushes it to the disk (fsync) before returning. Used for the temp file that is renamed over a data file: without the flush a power loss
 * after the rename can leave the data file empty or truncated, because the rename may reach the disk before the data does. The descriptor is closed even when the flush fails.
 */
export function writeFileDurably(path: string, content: string, mode: number, fs: DurableWriteFs = { openSync, writeSync: (fd, text) => writeSync(fd, text, null, 'utf-8'), fsyncSync, closeSync }): void {
  const fd = fs.openSync(path, 'w', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface AtomicRenameOptions {
  /** Test seam: the real rename. */
  rename?: (from: string, to: string) => void;
  /** Test seam: blocking sleep (the storage classes are synchronous). */
  sleep?: (ms: number) => void;
  /** Test seam: the real accessSync; throws when the path is not accessible in that mode. */
  access?: (path: string, mode: number) => void;
  attempts?: number;
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// undefined when the path can be written, else the error code of the check
function writeProblem(access: (path: string, mode: number) => void, path: string): string | undefined {
  try {
    access(path, constants.W_OK);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'unknown error';
  }
}

/**
 * Whether waiting can help after EPERM or EACCES: the existing target must be writable (then a program holds it for a moment). A target that does not exist
 * yet (the first write of a file) is held up by its source or its directory: retry while that directory is writable. Otherwise the problem is permanent.
 */
function worthRetrying(access: (path: string, mode: number) => void, target: string): { retry: true } | { retry: false; why: string } {
  const problem = writeProblem(access, target);
  if (problem === undefined) {
    return { retry: true };
  }
  if (problem !== 'ENOENT') {
    return { retry: false, why: `${target} is not writable, ${problem}` };
  }
  const directoryProblem = writeProblem(access, dirname(target));
  return directoryProblem === undefined ? { retry: true } : { retry: false, why: `the folder of ${target} is not writable, ${directoryProblem}` };
}

function failureMessage(from: string, to: string, code: string | undefined, how: string): string {
  return (
    `Could not replace ${to}: ${code} on rename from ${from}${how}. ` +
    `Either another program holds the file open (antivirus, indexer, an editor) or the file is read-only or denied by permissions (read-only attribute, ACL, folder rights). ` +
    `Close the program or exclude the queue config directory from its scan, then clear the read-only attribute and fix the permissions of ${to} (Windows: attrib -R "${to}"), and retry.`
  );
}

/**
 * Atomically replaces `to` by `from`, retrying a short while when the OS says the target is busy. EBUSY is always retried; EPERM and EACCES only while the
 * target is writable (see worthRetrying), so a read-only file fails at once instead of after a second of blocking. The wait is bounded by MAX_BLOCK_MS.
 * Anything else, a permanent permission problem and a target that stays busy throw with the paths and what to check.
 */
export function renameReplacing(from: string, to: string, options: AtomicRenameOptions = {}): void {
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? blockingSleep;
  const access = options.access ?? accessSync;
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
      if (code !== ALWAYS_TRANSIENT) {
        const verdict = worthRetrying(access, to);
        if (!verdict.retry) {
          throw new Error(failureMessage(from, to, code, ` (not retried: ${verdict.why})`), { cause: last });
        }
      }
      if (attempt < attempts) {
        sleep(PAUSE_MS);
      }
    }
  }
  throw new Error(failureMessage(from, to, last?.code, ` after ${attempts} attempts (${(attempts - 1) * PAUSE_MS} ms)`), { cause: last });
}
