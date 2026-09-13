import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import { RetryScheduler } from './RetryScheduler.js';
import { OutputCapture } from './OutputCapture.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { getErrorMessage } from '../errors.js';

export class AsyncDispatcher {
  private readonly cliTransport = new CliTransport();
  private readonly httpTransport = new HttpTransport();

  constructor(
    private readonly walUpdater: (id: string, updates: Partial<WalEntry>) => void,
    private readonly dlqMover: (entry: WalEntry, lastError: string) => void,
    // Required: the daemon has no usable stderr, an absent logger would make every failure invisible
    private readonly logger: QueueLogWriter,
  ) {}

  async dispatch(
    subscribers: ResolvedSubscriber[],
    envelope: EventEnvelope,
    walEntries: Map<string, WalEntry>
  ): Promise<void> {
    await Promise.all(
      subscribers.map(async (sub) => {
        const walEntry = walEntries.get(sub.subscriberId);
        if (!walEntry) {
          this.logger.logDiagnostic({
            source: 'AsyncDispatcher',
            message: `no WAL entry for subscriber ${sub.subscriberId} (event ${sub.event}); dispatch skipped`,
          });
          return;
        }

        let result;
        if (sub.type === 'cli') {
          if (!sub.command) {
            this.failConfig(walEntry, sub, `subscriber ${sub.subscriberId} has type 'cli' but no 'command' field in subscribers.yml`);
            return;
          }
          result = await this.cliTransport.dispatch(sub.command, envelope, sub.timeoutMs, sub.cwd, sub.env);
        } else {
          if (!sub.url) {
            this.failConfig(walEntry, sub, `subscriber ${sub.subscriberId} has type 'http' but no 'url' field in subscribers.yml`);
            return;
          }
          result = await this.httpTransport.dispatch(sub.url, sub.method ?? 'POST', sub.headers, envelope, sub.timeoutMs);
        }

        const target = sub.command ?? sub.url ?? '';
        const captured = OutputCapture.forLog(result.success, result.stdout, result.stderr);
        if (result.success) {
          this.walUpdater(walEntry.id, { status: 'acked', ackedAt: new Date().toISOString() });
          this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs, ...captured });
        } else {
          const newAttempts = walEntry.attempts + 1;
          const lastError = result.error ?? 'unknown error';
          this.walUpdater(walEntry.id, { status: 'failed', lastError, attempts: newAttempts });
          if (newAttempts < sub.retries) {
            this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts, ...captured });
            try {
              RetryScheduler.scheduleRetry({ ...walEntry, attempts: newAttempts });
            } catch (err) {
              this.logger.logDiagnostic({
                source: 'AsyncDispatcher',
                message: `failed to schedule retry for ${sub.subscriberId} (WAL ${walEntry.id}): ${getErrorMessage(err)}`,
              });
            }
          } else {
            this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts, ...captured });
            this.dlqMover({ ...walEntry, attempts: newAttempts }, lastError);
          }
        }
      })
    );
  }

  /** Misconfigured subscriber: fail the WAL entry and make the reason visible in the log file. */
  private failConfig(walEntry: WalEntry, sub: ResolvedSubscriber, error: string): void {
    const attempts = walEntry.attempts + 1;
    this.walUpdater(walEntry.id, { status: 'failed', lastError: error, attempts });
    this.logger.logDispatch({
      event: walEntry.event,
      subscriberId: sub.subscriberId,
      status: 'failed',
      error,
      attempts,
    });
  }
}
