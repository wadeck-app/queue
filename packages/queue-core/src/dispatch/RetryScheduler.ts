import { execFileSync, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecFileException } from 'node:child_process';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';

export type BackoffStrategy = 'exponential' | 'linear';

// The delay never goes past this many minutes: exponential 1, 2, 4, 8, 16 then 16 again; linear 1, 2, 3 ... 16 then 16 again
const MAX_DELAY_MINUTES = 16;

/**
 * The delay before the next try, from the number of attempts that already failed (0 for an entry that never ran).
 * exponential: 2^attempts minutes; linear: attempts + 1 minutes; both capped at 16 minutes (the unit orch understands: "8m").
 */
export function computeBackoff(attempts: number, backoff: BackoffStrategy = 'exponential'): string {
  return `${backoffMinutes(attempts, backoff)}m`;
}

/** The same delay as {@link computeBackoff}, in minutes. */
export function backoffMinutes(attempts: number, backoff: BackoffStrategy = 'exponential'): number {
  const step = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  const minutes = backoff === 'linear' ? step + 1 : 2 ** Math.min(step, 10);
  return Math.min(minutes, MAX_DELAY_MINUTES);
}

/** Test seam: what the scheduler needs from the machine. */
export interface SchedulerDeps {
  /** The path of orch, or null when it is not on the PATH. */
  findOrch(): string | null;
  /** Runs orch and waits for it; throws when it fails. */
  runSync(file: string, args: string[]): void;
  /** A short random token that makes the job id unique. */
  randomSuffix(): string;
  /** Runs orch without waiting; the callback receives its failure, if any. */
  runAsync(file: string, args: string[], callback: (err: ExecFileException | null, stdout: string, stderr: string) => void): void;
}

function findOrch(): string | null {
  const isWindows = process.platform === 'win32';
  try {
    const result = execFileSync(isWindows ? 'where' : 'which', ['orch'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const line = result.trim().split('\n')[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

const defaultDeps: SchedulerDeps = {
  findOrch,
  randomSuffix: () => randomUUID().slice(0, 8),
  runSync: (file, args) => { execFileSync(file, args, { stdio: 'pipe', windowsHide: true }); },
  runAsync: (file, args, callback) => { execFile(file, args, { windowsHide: true }, callback); },
};

export interface ScheduleOptions {
  /** The strategy of the subscriber the entry belongs to; absent: exponential. */
  backoff?: BackoffStrategy;
  /** Receives the failure of the asynchronous call (orch exited with an error or could not be spawned); absent: stderr. */
  onError?: (error: Error) => void;
}

function failure(entry: WalEntry, cause: unknown, stderr: string): Error {
  const orchSays = stderr.trim() !== '' ? ` orch said: ${stderr.trim().slice(0, 500)}.` : '';
  const stderrOfCause = (cause as { stderr?: unknown } | undefined)?.stderr;
  const fromCause = stderr === '' && stderrOfCause !== undefined && String(stderrOfCause).trim() !== '' ? ` orch said: ${String(stderrOfCause).trim().slice(0, 500)}.` : '';
  return new Error(
    `could not schedule the retry of WAL entry ${entry.id} (${entry.subscriberId}): ${getErrorMessage(cause)}.${orchSays}${fromCause} ` +
    `The entry stays in the WAL and is not retried automatically. Fix: check that orch works (orch list), then run it by hand: queue retry --event ${entry.id}`,
    { cause },
  );
}

export class RetryScheduler {
  /** Replaced by tests only. */
  static deps: SchedulerDeps = defaultDeps;

  /**
   * Asks orch for a one-shot job that runs `queue retry --event <id>` after the backoff. `useSync` waits for orch (the daemon is shutting down).
   * Throws when orch is missing or, with `useSync`, when it fails; the asynchronous failure goes to `options.onError`.
   */
  static scheduleRetry(entry: WalEntry, useSync = false, options: ScheduleOptions = {}): void {
    const deps = RetryScheduler.deps;
    const orchPath = deps.findOrch();
    if (!orchPath) {
      throw new Error(
        'orch not found on PATH. Install @wadeck/orchestrator to enable retry scheduling.\n' +
        'Add orch to your PATH or install it globally.'
      );
    }

    const backoffStr = computeBackoff(entry.attempts, options.backoff);
    // orch add --once <id> --delay <duration> --command <cmd>: the id and --command are required (the call without them exits 4: "--command is required"). An orch id has only letters, digits and "-"; it is unique per call so a job that already fired never makes the next one a duplicate
    const jobId = `queue-retry-${entry.id.replace(/[^a-z0-9-]/gi, '-')}-${Math.max(0, Math.floor(entry.attempts) || 0)}-${deps.randomSuffix()}`;
    const args = ['add', '--once', jobId, '--delay', backoffStr, '--command', `queue retry --event ${entry.id}`];

    if (useSync) {
      try {
        deps.runSync(orchPath, args);
      } catch (err) {
        throw failure(entry, err, '');
      }
    } else {
      deps.runAsync(orchPath, args, (err, _stdout, stderr) => {
        if (err) {
          const error = failure(entry, err, stderr);
          if (options.onError !== undefined) {
            options.onError(error);
          } else {
            process.stderr.write(`[queue] RetryScheduler: ${getErrorMessage(error)}\n`);
          }
        }
      });
    }
  }
}
