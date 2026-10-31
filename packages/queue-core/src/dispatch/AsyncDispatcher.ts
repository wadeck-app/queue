import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import type { ActionTransport } from './ActionTransport.js';
import { runSubscriber, targetOf } from './runSubscriber.js';
import { RetryScheduler } from './RetryScheduler.js';
import { OutputCapture } from './OutputCapture.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import { projectRefsOf, type HistoryWriter } from '../storage/HistoryLog.js';
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
    // Terse audit trail for `queue history`, written unconditionally unlike logger.logDispatch
    private readonly historyLog: HistoryWriter,
    // Absent: an action subscriber fails for good with a message that says no actions run in this process
    private readonly actionTransport?: ActionTransport,
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

        const outcome = await runSubscriber(sub, envelope, sub.timeoutMs, { cli: this.cliTransport, http: this.httpTransport, action: this.actionTransport });
        if (outcome.kind === 'config') {
          this.failConfig(envelope, walEntry, sub, outcome.error);
          return;
        }
        const result = outcome.result;
        const target = targetOf(sub) ?? '';
        const captured = OutputCapture.forLog(result.success, result.stdout, result.stderr);
        if (result.success) {
          this.walUpdater(walEntry.id, { status: 'acked', ackedAt: new Date().toISOString() });
          this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs, ...captured, ...(result.detail !== undefined && { detail: result.detail }) });
          this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, ...projectRefsOf(envelope.meta) });
        } else {
          const newAttempts = walEntry.attempts + 1;
          const lastError = result.error ?? 'unknown error';
          this.walUpdater(walEntry.id, { status: 'failed', lastError, attempts: newAttempts });
          // A permanent failure (refused value, bad command) would fail the same way again: no retry
          if (newAttempts < sub.retries && result.permanent !== true) {
            this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts, ...captured });
            this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, ...projectRefsOf(envelope.meta) });
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
            this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target, ...projectRefsOf(envelope.meta) });
            this.dlqMover({ ...walEntry, attempts: newAttempts }, lastError);
          }
        }
      })
    );
  }

  /**
   * Misconfigured subscriber (no command, unknown action, no folder to run from...): the same configuration would fail the same way on every retry,
   * so the entry goes straight to the DLQ with the reason, instead of staying 'failed' in the WAL with nobody looking at it.
   */
  private failConfig(envelope: EventEnvelope, walEntry: WalEntry, sub: ResolvedSubscriber, reason: string): void {
    const attempts = walEntry.attempts + 1;
    const error = `${reason} (not retried: fix subscribers.yml, then replay the entry from the DLQ: queue dlq replay --id ${walEntry.id})`;
    this.walUpdater(walEntry.id, { status: 'failed', lastError: error, attempts });
    this.logger.logDispatch({
      event: walEntry.event,
      subscriberId: sub.subscriberId,
      status: 'dlq',
      target: targetOf(sub),
      error,
      attempts,
    });
    this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target: targetOf(sub), ...projectRefsOf(envelope.meta) });
    this.dlqMover({ ...walEntry, attempts }, error);
  }
}
