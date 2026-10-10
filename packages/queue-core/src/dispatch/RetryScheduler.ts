import { execFileSync, execFile } from 'node:child_process';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';

const BACKOFF_EXPONENTIAL = ['1m', '2m', '4m', '8m', '16m'];

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

function computeBackoff(attempts: number): string {
  return BACKOFF_EXPONENTIAL[Math.min(attempts, BACKOFF_EXPONENTIAL.length - 1)]!;
}

export class RetryScheduler {
  static scheduleRetry(entry: WalEntry, useSync = false): void {
    const orchPath = findOrch();
    if (!orchPath) {
      throw new Error(
        'orch not found on PATH. Install @wadeck/orchestrator to enable retry scheduling.\n' +
        'Add orch to your PATH or install it globally.'
      );
    }

    const backoffStr = computeBackoff(entry.attempts);
    const args = ['add', '--once', '--delay', backoffStr, `queue retry --event ${entry.id}`];

    if (useSync) {
      execFileSync(orchPath, args, { stdio: 'pipe', windowsHide: true });
    } else {
      execFile(orchPath, args, { windowsHide: true }, (err) => {
        if (err) {
          process.stderr.write(`[queue] RetryScheduler: failed to schedule retry for ${entry.id}: ${getErrorMessage(err)}\n`);
        }
      });
    }
  }
}
