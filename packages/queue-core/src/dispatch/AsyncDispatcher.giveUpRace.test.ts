import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncDispatcher, inFlightWalUpdater } from './AsyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import { RetryScheduler } from './RetryScheduler.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { DlqStore } from '../storage/DlqStore.js';
import { abandonInFlightEntryDetailed } from '../operations.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

/**
 * The reverse of the give-up compare-and-set: a delivery that is still running when `give-up` claims its entry must not acknowledge (or fail, or move to the DLQ)
 * an entry that is no longer in flight. The interleaving is forced: the give-up runs inside the transport call, between the end of the dispatch and the WAL write.
 */
describe('AsyncDispatcher against a give-up that claims the entry while the delivery runs', () => {
  let configDir: string;
  let wal: Wal;
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dlqMover: ReturnType<typeof vi.fn<(entry: WalEntry, lastError: string) => void>>;
  let dispatcher: AsyncDispatcher;
  let entry: WalEntry;

  const envelope: EventEnvelope = { id: 'env-id', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTicket.created', payload: {}, meta: { cwd: '/tmp' } };
  const sub: ResolvedSubscriber = {
    subscriberId: 'sub-1', name: 'sub-1', file: 'subscribers.yml', scope: 'global', event: 'onTicket.created', type: 'cli', command: 'echo ok', retries: 3, timeoutMs: 5000, backoff: 'exponential',
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-giveup-race-'));
    wal = new Wal(join(configDir, 'wal.ndjson'));
    entry = { id: 'wal-1', timestamp: new Date().toISOString(), event: 'onTicket.created', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 'sub-1', status: 'pending', attempts: 0 };
    wal.append(entry);
    logger = { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
    historyLog = { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() };
    dlqMover = vi.fn<(entry: WalEntry, lastError: string) => void>();
    dispatcher = new AsyncDispatcher(inFlightWalUpdater(wal), dlqMover as never, logger, historyLog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** The give-up lands after the command ended and before the dispatcher writes its outcome. */
  function giveUpDuring(result: { success: boolean; error?: string }): void {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockImplementation(async () => {
      expect(abandonInFlightEntryDetailed(configDir, entry.id).status).toBe('moved');
      return { ...result, durationMs: 1 };
    });
  }

  const walStatus = (): string | undefined => wal.readAll().find((e) => e.id === entry.id)?.status;
  const diagnostics = (): string[] => (logger.logDiagnostic as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { message: string }).message);

  it('a success that arrives after the give-up does not acknowledge the entry: it stays dlq, one replayable row, no double delivery state', async () => {
    giveUpDuring({ success: true });

    await dispatcher.dispatch([sub], envelope, new Map([['sub-1', entry]]));

    expect(walStatus()).toBe('dlq');
    expect(wal.readAll().find((e) => e.id === entry.id)?.ackedAt).toBeUndefined();
    expect(new DlqStore(join(configDir, 'dlq.ndjson')).readAll().map((row) => row.id)).toEqual([entry.id]);
    expect(historyLog.logOutcome).not.toHaveBeenCalled();
    expect(logger.logDispatch).not.toHaveBeenCalled();
    expect(diagnostics().join('\n')).toMatch(/wal-1.*no longer in flight/);
  });

  it('a failure that arrives after the give-up does not overwrite the status, does not schedule a retry and does not move the entry a second time', async () => {
    const scheduled = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    giveUpDuring({ success: false, error: 'exit code 1' });

    await dispatcher.dispatch([sub], envelope, new Map([['sub-1', entry]]));

    expect(walStatus()).toBe('dlq');
    expect(scheduled).not.toHaveBeenCalled();
    expect(dlqMover).not.toHaveBeenCalled();
    expect(diagnostics().join('\n')).toMatch(/wal-1.*no longer in flight/);
  });

  it('a final failure (no retry left) that arrives after the give-up does not call the DLQ mover', async () => {
    giveUpDuring({ success: false, error: 'exit code 1' });

    await dispatcher.dispatch([{ ...sub, retries: 0 }], envelope, new Map([['sub-1', entry]]));

    expect(walStatus()).toBe('dlq');
    expect(dlqMover).not.toHaveBeenCalled();
    expect(diagnostics().join('\n')).toMatch(/no longer in flight/);
  });

  it('without a give-up the same delivery is acknowledged as before (the guard only refuses what left the flight)', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, durationMs: 1 });

    await dispatcher.dispatch([sub], envelope, new Map([['sub-1', entry]]));

    expect(walStatus()).toBe('acked');
    expect(diagnostics()).toEqual([]);
  });

  it('a retry (entry in status failed) is still acknowledged', async () => {
    wal.updateEntry(entry.id, { status: 'failed', attempts: 1 });
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, durationMs: 1 });

    await dispatcher.dispatch([sub], envelope, new Map([['sub-1', { ...entry, status: 'failed', attempts: 1 }]]));

    expect(walStatus()).toBe('acked');
  });

  it('an entry cleared from the WAL while the delivery runs is reported, not resurrected', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockImplementation(async () => {
      wal.removeWhere((e) => e.id === entry.id);
      return { success: true, durationMs: 1 };
    });

    await dispatcher.dispatch([sub], envelope, new Map([['sub-1', entry]]));

    expect(wal.readAll()).toEqual([]);
    expect(diagnostics().join('\n')).toMatch(/wal-1.*no longer/);
  });
});
