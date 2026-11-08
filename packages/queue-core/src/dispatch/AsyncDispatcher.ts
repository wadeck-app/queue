import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import type { ActionTransport } from './ActionTransport.js';
import type { RefResolver } from './refResolver.js';
import type { DlqAddedInfo } from '../dlqEvents.js';
import { runSubscriber, targetOf } from './runSubscriber.js';
import { RetryScheduler, backoffMinutes } from './RetryScheduler.js';
import { OutputCapture } from './OutputCapture.js';
import type { Wal, WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import { projectRefsOf, type HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { getErrorMessage } from '../errors.js';

/**
 * Writes a status change of a WAL entry. Returns `false` when it wrote nothing because the entry is no longer in flight (see {@link inFlightWalUpdater});
 * any other return value (including none) means the change was applied.
 */
export type WalUpdater = (id: string, updates: Partial<WalEntry>) => boolean | void;

/**
 * The updater the daemon uses: a compare-and-set under the WAL lock that applies the change only while the entry is still `pending` or `failed`.
 * A give-up (or a clear) that claimed the entry while its delivery ran wins: the late result of that delivery must not turn a `dlq` entry into `acked`
 * (it would be acknowledged and replayable from the DLQ at once: a double delivery).
 */
export function inFlightWalUpdater(wal: Wal): WalUpdater {
  return (id, updates) => wal.updateEntryIf(id, (entry) => entry.status === 'pending' || entry.status === 'failed', updates).status === 'updated';
}

/** The write of a result is attempted this many times in a row before it is kept aside (see {@link AsyncDispatcher.retryUnrecorded}). */
const RECORD_ATTEMPTS = 3;
/** A kept-aside write is retried this many times (one per call of retryUnrecorded, the daemon's idle check) before it is given up. */
const MAX_UNRECORDED_TRIES = 30;
/** Bound of the memory of causes already reported. */
const MAX_SAID = 200;

interface UnrecordedWrite {
  updates: Partial<WalEntry>;
  label: string;
  tries: number;
}

export class AsyncDispatcher {
  private readonly cliTransport = new CliTransport();
  private readonly httpTransport = new HttpTransport();
  // Causes already reported: a log that stays unwritable would otherwise say the same thing on every dispatch
  private readonly said = new Set<string>();
  // Results of deliveries that did run but could not be written to the WAL: id -> the write still to do
  private readonly unrecorded = new Map<string, UnrecordedWrite>();

  constructor(
    private readonly walUpdater: WalUpdater,
    // `info` says why the entry is given up (and the exit code and target of the last attempt): the facts of the queue.dlq.added event
    // Awaited: the mover emits queue.dlq.added BEFORE it writes the DLQ row (a crash in between gives a duplicate event, never a loss)
    private readonly dlqMover: (entry: WalEntry, lastError: string, info: DlqAddedInfo) => void | Promise<void>,
    // Required: the daemon has no usable stderr, an absent logger would make every failure invisible
    private readonly logger: QueueLogWriter,
    // Terse audit trail for `queue history`, written unconditionally unlike logger.logDispatch
    private readonly historyLog: HistoryWriter,
    // Absent: an action subscriber fails for good with a message that says no actions run in this process
    private readonly actionTransport?: ActionTransport,
    // Absent: no payload reference is followed in the templates of a cli subscriber
    private readonly refs?: RefResolver,
    // Called when the retry job of a failed entry could not be created (orch missing or failing): the host reports it and marks the entry. Absent: a diagnostic only
    private readonly onRetryNotScheduled?: (entry: WalEntry, error: Error) => void,
  ) {}

  /** How many delivered entries still wait for their acknowledgement to be written to the WAL. */
  get unrecordedCount(): number {
    return this.unrecorded.size;
  }

  /**
   * Writes again the results that could not be written when the delivery finished (a WAL locked by a scanner, a full disk). Returns how many are still waiting.
   * Bounded: after MAX_UNRECORDED_TRIES calls an entry is dropped from here, loudly (it stays pending and a restart or a retry delivers it again).
   */
  retryUnrecorded(): number {
    for (const [id, write] of [...this.unrecorded]) {
      try {
        this.walUpdater(id, write.updates);
        this.unrecorded.delete(id);
        this.diagnostic('info', `the result of ${write.label} was written to the WAL after all (it had been kept aside)`);
      } catch (err) {
        write.tries++;
        if (write.tries >= MAX_UNRECORDED_TRIES) {
          this.unrecorded.delete(id);
          this.diagnostic('warn', `gave up writing the result of ${write.label} after ${write.tries} attempts (${getErrorMessage(err)}): the entry stays pending in the WAL and its next retry or a restart delivers it again. Fix the permissions or locks of wal.ndjson in the queue config directory; \`queue dlq\` and the Pending page show it`);
        }
      }
    }
    return this.unrecorded.size;
  }

  /** Says something in the daemon log; when the log itself is the problem, on stderr. Never throws. */
  private diagnostic(level: 'info' | 'warn', message: string): void {
    try {
      this.logger.logDiagnostic({ source: 'AsyncDispatcher', level, message });
    } catch {
      process.stderr.write(`[queue] AsyncDispatcher: ${message}\n`);
    }
  }

  /**
   * A log write (daemon log or history) must never decide what happens to a delivery: a locked day file (antivirus, indexer) used to leave the entry 'failed' with no retry job
   * and no DLQ move until the stuck give-up two hours later. A failure is said once per cause, in the daemon log (stderr when that is what failed).
   */
  private safely(what: string, write: () => void): void {
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
      this.diagnostic('warn', `could not write the ${what} record (${message}); the delivery itself, its retry and its move to the dead-letter queue were not affected. Check that nothing locks the logs and history folders of the queue config directory and that the disk has room. This is said once per cause`);
    }
  }

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

        const outcome = await runSubscriber(sub, envelope, sub.timeoutMs, { cli: this.cliTransport, http: this.httpTransport, action: this.actionTransport, refs: this.refs });
        if (outcome.kind === 'config') {
          await this.failConfig(envelope, walEntry, sub, outcome.error);
          return;
        }
        const result = outcome.result;
        const target = targetOf(sub) ?? '';
        // A cli run is logged with its exit code and output tails, success included; other transports keep the older capture (an http body is not logged on success)
        const captured = sub.type === 'cli' ? OutputCapture.dispatchFields(result) : OutputCapture.forLog(result.success, result.stdout, result.stderr);
        if (result.success) {
          // 'unwritten' (kept aside, said loudly): the delivery ran, so its traces are still due
          if (this.record(walEntry, sub, { status: 'acked', ackedAt: new Date().toISOString() }, 'its delivery succeeded', true) === 'gone') {
            return;
          }
          this.safely('dispatch log', () => this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs, ...captured, ...(result.detail !== undefined && { detail: result.detail }) }));
          this.safely('history', () => this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, ...projectRefsOf(envelope.meta) }));
        } else {
          const newAttempts = walEntry.attempts + 1;
          const lastError = result.error ?? 'unknown error';
          // A permanent failure (refused value, bad command) would fail the same way again: no retry
          const willRetry = newAttempts < sub.retries && result.permanent !== true;
          // The due time of the retry goes with the status: the "stuck" limit follows the plan of the entry (see retryDueAt)
          const retryDueAt = willRetry ? new Date(Date.now() + backoffMinutes(newAttempts, sub.backoff) * 60_000).toISOString() : undefined;
          // 'unwritten' (the WAL could not be written): the retry or the move below still happens, they do not depend on that status
          if (this.record(walEntry, sub, { status: 'failed', lastError, attempts: newAttempts, ...(retryDueAt !== undefined && { retryDueAt }) }, `its delivery failed (${lastError})`, false) === 'gone') {
            return;
          }
          if (willRetry) {
            // The retry job first, the traces after: a log that cannot be written must not leave the entry without a retry
            const retrying: WalEntry = { ...walEntry, attempts: newAttempts, lastError };
            try {
              RetryScheduler.scheduleRetry(retrying, false, { backoff: sub.backoff, onError: (error) => this.retryNotScheduled(retrying, error) });
            } catch (err) {
              this.retryNotScheduled(retrying, err instanceof Error ? err : new Error(getErrorMessage(err)));
            }
            this.safely('dispatch log', () => this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts, ...captured, ...(result.detail !== undefined && { detail: result.detail }) }));
            this.safely('history', () => this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, ...projectRefsOf(envelope.meta) }));
          } else {
            this.safely('dispatch log', () => this.logger.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts, ...captured, ...(result.detail !== undefined && { detail: result.detail }) }));
            this.safely('history', () => this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target, ...projectRefsOf(envelope.meta) }));
            await this.dlqMover({ ...walEntry, attempts: newAttempts }, lastError, {
              reason: result.permanent === true ? 'permanent-failure' : 'retries-exhausted',
              ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
              ...(target !== '' && { target }),
            });
          }
        }
      })
    );
  }

  /**
   * Writes the outcome of a delivery to the WAL. `gone` (nothing written, nothing else to do for this entry) when the entry is no longer in flight: a give-up or a clear
   * took it while the delivery ran, and the entry now lives in the DLQ (where it can be replayed) or is gone. The delivery did run, so the diagnostic says what happened to it.
   * `unwritten` when the WAL could not be written even after a few immediate attempts (a scanner holds the file). With `keepAside` (a success) the write is kept and retried
   * (retryUnrecorded), loudly: the entry stays pending although it was delivered, and a restart would deliver it a second time.
   */
  private record(walEntry: WalEntry, sub: ResolvedSubscriber, updates: Partial<WalEntry>, what: string, keepAside: boolean): 'recorded' | 'gone' | 'unwritten' {
    let failure: unknown;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
      try {
        if (this.walUpdater(walEntry.id, updates) !== false) {
          return 'recorded';
        }
        this.diagnostic('warn', `WAL entry ${walEntry.id} (event ${walEntry.event}, subscriber ${sub.subscriberId}) is no longer in flight (given up or cleared while it ran): ${what}, but the entry was left as it is, so nothing was recorded, retried or moved. `
          + 'If it was given up it is in the DLQ and replaying it delivers again: check `queue dlq list` before replaying.');
        return 'gone';
      } catch (err) {
        failure = err;
      }
    }
    const label = `WAL entry ${walEntry.id} (event ${walEntry.event}, subscriber ${sub.subscriberId})`;
    if (keepAside) {
      this.unrecorded.set(walEntry.id, { updates, label, tries: 0 });
      this.diagnostic('warn', `${label}: ${what}, but the WAL could not be written (${getErrorMessage(failure)}). The entry stays pending although it was delivered: the daemon keeps trying to write the acknowledgement and stays awake until it does; if it cannot, its next retry or a restart delivers it again. Check that nothing locks wal.ndjson in the queue config directory`);
    } else {
      this.diagnostic('warn', `${label}: ${what}, but the WAL could not be written (${getErrorMessage(failure)}); the entry keeps its previous status`);
    }
    return 'unwritten';
  }

  /** The retry job of an entry could not be created: the host says why once and marks the entry (without a host, a diagnostic). Never throws. */
  private retryNotScheduled(entry: WalEntry, error: Error): void {
    if (this.onRetryNotScheduled === undefined) {
      this.diagnostic('warn', getErrorMessage(error));
      return;
    }
    try {
      this.onRetryNotScheduled(entry, error);
    } catch (err) {
      this.diagnostic('warn', `${getErrorMessage(error)} (and marking the entry failed: ${getErrorMessage(err)})`);
    }
  }

  /**
   * Misconfigured subscriber (no command, unknown action, no folder to run from...): the same configuration would fail the same way on every retry,
   * so the entry goes straight to the DLQ with the reason, instead of staying 'failed' in the WAL with nobody looking at it.
   */
  private async failConfig(envelope: EventEnvelope, walEntry: WalEntry, sub: ResolvedSubscriber, reason: string): Promise<void> {
    const attempts = walEntry.attempts + 1;
    const error = `${reason} (not retried: fix subscribers.yml, then replay the entry from the DLQ: queue dlq replay --id ${walEntry.id})`;
    if (this.record(walEntry, sub, { status: 'failed', lastError: error, attempts }, `its configuration is invalid (${reason})`, false) === 'gone') {
      return;
    }
    this.safely('dispatch log', () => this.logger.logDispatch({
      event: walEntry.event,
      subscriberId: sub.subscriberId,
      status: 'dlq',
      target: targetOf(sub),
      error,
      attempts,
    }));
    this.safely('history', () => this.historyLog.logOutcome({ eventId: envelope.id, event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target: targetOf(sub), ...projectRefsOf(envelope.meta) }));
    const target = targetOf(sub);
    await this.dlqMover({ ...walEntry, attempts }, error, { reason: 'invalid-configuration', ...(target !== undefined && { target }) });
  }
}
