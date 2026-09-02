import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import { RetryScheduler } from './RetryScheduler.js';
import type { WalEntry } from '../storage/Wal.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { getErrorMessage } from '../errors.js';

interface DispatchLogger {
  logDispatch(entry: { event: string; subscriberId: string; status: 'success' | 'failed' | 'dlq'; target?: string; durationMs?: number; error?: string; attempts?: number }): void;
}

export class AsyncDispatcher {
  private readonly cliTransport = new CliTransport();
  private readonly httpTransport = new HttpTransport();

  constructor(
    private readonly walUpdater: (id: string, updates: Partial<WalEntry>) => void,
    private readonly dlqMover: (entry: WalEntry, lastError: string) => void,
    private readonly logger?: DispatchLogger,
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
          process.stderr.write(`[queue] AsyncDispatcher: no WAL entry for subscriber ${sub.subscriberId}\n`);
          return;
        }

        let result;
        if (sub.type === 'cli') {
          if (!sub.command) {
            this.walUpdater(walEntry.id, { status: 'failed', lastError: 'CLI subscriber missing command', attempts: walEntry.attempts + 1 });
            return;
          }
          result = await this.cliTransport.dispatch(sub.command, envelope, sub.timeoutMs);
        } else {
          if (!sub.url) {
            this.walUpdater(walEntry.id, { status: 'failed', lastError: 'HTTP subscriber missing url', attempts: walEntry.attempts + 1 });
            return;
          }
          result = await this.httpTransport.dispatch(sub.url, sub.method ?? 'POST', sub.headers, envelope, sub.timeoutMs);
        }

        const target = sub.command ?? sub.url ?? '';
        if (result.success) {
          this.walUpdater(walEntry.id, { status: 'acked', ackedAt: new Date().toISOString() });
          this.logger?.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs });
        } else {
          const newAttempts = walEntry.attempts + 1;
          const lastError = result.error ?? 'unknown error';
          this.walUpdater(walEntry.id, { status: 'failed', lastError, attempts: newAttempts });
          if (newAttempts < sub.retries) {
            this.logger?.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'failed', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts });
            try {
              RetryScheduler.scheduleRetry({ ...walEntry, attempts: newAttempts });
            } catch (err) {
              process.stderr.write(`[queue] AsyncDispatcher: ${getErrorMessage(err)}\n`);
            }
          } else {
            this.logger?.logDispatch({ event: walEntry.event, subscriberId: sub.subscriberId, status: 'dlq', target, durationMs: result.durationMs, error: lastError, attempts: newAttempts });
            this.dlqMover({ ...walEntry, attempts: newAttempts }, lastError);
          }
        }
      })
    );
  }
}
