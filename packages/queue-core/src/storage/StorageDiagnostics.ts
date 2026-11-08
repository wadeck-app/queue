import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getErrorMessage } from '../errors.js';

/**
 * What the WAL and the DLQ have to tell: the daemon passes EventLogger.logDiagnostic (its stdio is ignored, so a stderr line is lost); this shape is a subset of
 * its DiagnosticLogEntry.
 */
export interface StorageDiagnostic {
  /** The component, e.g. 'Wal' or 'DlqStore'. */
  source: string;
  message: string;
  level?: 'info' | 'warn';
}

export type StorageDiagnosticSink = (diagnostic: StorageDiagnostic) => void;

/** The default sink: stderr, for the programs that read or edit the queue files directly (the CLI). */
export const stderrDiagnosticSink: StorageDiagnosticSink = (diagnostic) => {
  process.stderr.write(`[queue] ${diagnostic.source}: ${diagnostic.message}\n`);
};

/**
 * Reads an ndjson queue file: a line that is not valid JSON, or is valid JSON that `isEntry` refuses (`null`, a number, an array, an object without the fields
 * every reader relies on), comes back raw in `corrupt` instead of crashing every later read and append. A missing file is empty.
 */
export function parseQueueFile<T>(file: string, isEntry: (value: unknown) => value is T): { entries: T[]; corrupt: string[] } {
  const entries: T[] = [];
  const corrupt: string[] = [];
  if (!existsSync(file)) {
    return { entries, corrupt };
  }
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isEntry(value)) {
        entries.push(value);
      } else {
        corrupt.push(trimmed);
      }
    } catch {
      corrupt.push(trimmed);
    }
  }
  return { entries, corrupt };
}

/** A plain JSON object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SAMPLE_CHARS = 80;
// A temp file of a crashed writer is removed once it is this old, even if its pid has been reused by another program
const STALE_TEMP_MS = 3600_000;

/**
 * Keeps the lines of a queue file that are not valid JSON before a rewrite drops them: appends the raw lines to `<file>.corrupt` (0600) and tells the sink
 * (once per line: a line already in the .corrupt file is not added or reported again, which matters because an operation that changes nothing leaves the
 * line in the queue file). Never throws: when the lines cannot be kept the sink says they are lost, with the reason, and the operation goes on.
 */
export function quarantineCorruptLines(file: string, lines: string[], source: string, sink: StorageDiagnosticSink): void {
  if (lines.length === 0) {
    return;
  }
  const corruptPath = `${file}.corrupt`;
  try {
    const known = new Set(existsSync(corruptPath) ? readFileSync(corruptPath, 'utf-8').split('\n') : []);
    const fresh = [...new Set(lines)].filter((line) => !known.has(line));
    if (fresh.length === 0) {
      return;
    }
    appendFileSync(corruptPath, fresh.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
    try {
      chmodSync(corruptPath, 0o600);
    } catch {
      // chmod is a no-op on Windows; acceptable
    }
    sink({
      source,
      level: 'warn',
      message:
        `${fresh.length} unreadable line(s) found in ${file} (not valid JSON, or JSON that is not a queue entry: most likely a write cut short by a crash or a hand edit; they are kept exactly as they were) were moved to ${corruptPath} before the file was rewritten. ` +
        `First: ${fresh[0]!.slice(0, SAMPLE_CHARS)}. Inspect them there and re-add by hand what is still needed.`,
    });
  } catch (err) {
    const reason = getErrorMessage(err);
    sink({
      source,
      level: 'warn',
      message:
        `${lines.length} unreadable line(s) in ${file} could not be kept in ${corruptPath} (${reason}) and are dropped by the rewrite. ` +
        `First: ${lines[0]!.slice(0, SAMPLE_CHARS)}. Fix the permissions of ${join(dirname(file))} so that the file can be created.`,
    });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes the leftover `<file>.<pid>.tmp` files of writers that died between writing their temp file and renaming it: those of a process that no longer
 * exists, and any older than an hour. A fresh temp file of a live process is another writer in the middle of a replace and stays. Returns what it removed;
 * a file that cannot be removed is skipped (it is retried at the next start).
 */
export function removeStaleTempFiles(file: string, now: number = Date.now()): string[] {
  const prefix = `${basename(file)}.`;
  const dir = dirname(file);
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const match = name.startsWith(prefix) ? /^(\d+)\.tmp$/.exec(name.slice(prefix.length)) : null;
    if (match === null) {
      continue;
    }
    const path = join(dir, name);
    try {
      const age = now - statSync(path).mtimeMs;
      if (age > STALE_TEMP_MS || !isProcessAlive(Number(match[1]))) {
        unlinkSync(path);
        removed.push(name);
      }
    } catch {
      // Gone already, or held open: the next start retries
    }
  }
  return removed;
}
