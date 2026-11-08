import { getErrorMessage } from '../errors.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';

const MAX_SAID = 200;

/**
 * A log write (daemon log or history) must never decide what happens to a delivery or to a before* event: a locked day file (antivirus, indexer) used to leave an
 * entry 'failed' with no retry job, or turn a successful chain into a failed push. A failure is said once per cause, in the daemon log (stderr when that is what failed).
 */
export class LogGuard {
  // Causes already reported: a log that stays unwritable would otherwise say the same thing on every dispatch
  private readonly said = new Set<string>();

  constructor(
    private readonly logger: QueueLogWriter,
    private readonly source: string,
    /** What the failed write did not change, in the sentence that reports it. */
    private readonly unaffected: string,
  ) {}

  /** Says something in the daemon log; when the log itself is the problem, on stderr. Never throws. */
  diagnostic(level: 'info' | 'warn', message: string): void {
    try {
      this.logger.logDiagnostic({ source: this.source, level, message });
    } catch {
      process.stderr.write(`[queue] ${this.source}: ${message}\n`);
    }
  }

  /** Runs a log write; a failure is reported once per cause and never thrown. `what` names the record ("history", "dispatch log"). */
  safely(what: string, write: () => void): void {
    try {
      write();
    } catch (err) {
      const message = getErrorMessage(err);
      const key = `${what}\0${message}`;
      if (this.said.has(key)) {
        return;
      }
      if (this.said.size >= MAX_SAID) {
        this.said.clear();
      }
      this.said.add(key);
      this.diagnostic('warn', `could not write the ${what} record (${message}); ${this.unaffected} were not affected. Check that nothing locks the logs and history folders of the queue config directory and that the disk has room. This is said once per cause`);
    }
  }
}
