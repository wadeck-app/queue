import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { DlqAddedInfo } from '../dlqEvents.js';
import { AsyncDispatcher, type WalUpdater } from './AsyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import { RetryScheduler } from './RetryScheduler.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { walEntry as baseWalEntry } from '../queueEntries.testUtil.js';

const envelope: EventEnvelope = { id: 'env', timestamp: '2026-01-01T00:00:00.000Z', event: 'onX', payload: {}, meta: { cwd: '/tmp' } };

function sub(overrides: Partial<ResolvedSubscriber> = {}): ResolvedSubscriber {
  return { subscriberId: 's1', name: 's1', file: 'subscribers.yml', scope: 'global', event: 'onX', type: 'cli', command: 'echo ok', retries: 3, timeoutMs: 5000, backoff: 'exponential', ...overrides };
}

const walEntry = (id = crypto.randomUUID()): WalEntry => baseWalEntry(id, { subscriberId: 's1' });

const diskLocked = (): never => { throw new Error('EBUSY: resource busy or locked, open the day file'); };

describe('AsyncDispatcher: a log failure never decides what happens to the delivery', () => {
  let logger: QueueLogWriter;
  let history: HistoryWriter;
  let walUpdater: ReturnType<typeof vi.fn> & WalUpdater;
  let dlqMover: Mock<(entry: WalEntry, lastError: string, info: DlqAddedInfo) => void>;
  let dispatcher: AsyncDispatcher;
  let scheduled: Mock<typeof RetryScheduler.scheduleRetry>;

  beforeEach(() => {
    logger = { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
    history = { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() };
    walUpdater = vi.fn() as ReturnType<typeof vi.fn> & WalUpdater;
    dlqMover = vi.fn<(entry: WalEntry, lastError: string, info: DlqAddedInfo) => void>();
    dispatcher = new AsyncDispatcher(walUpdater, dlqMover, logger, history);
    scheduled = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const fail = (error = 'exit code 1'): void => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error, durationMs: 1 });
  };
  const succeed = (): void => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
  };
  const run = (entry: WalEntry, overrides: Partial<ResolvedSubscriber> = {}): Promise<void> => dispatcher.dispatch([sub(overrides)], envelope, new Map([['s1', entry]]));

  it('a failed delivery whose dispatch log cannot be written is still retried', async () => {
    fail();
    vi.mocked(logger.logDispatch).mockImplementation(diskLocked);
    const entry = walEntry();
    await run(entry);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.mock.calls[0]![0]).toMatchObject({ id: entry.id, attempts: 1 });
  });

  it('a failed delivery whose history cannot be written is still retried', async () => {
    fail();
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    await run(walEntry());
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('a delivery that goes to the DLQ is moved there even when both logs fail', async () => {
    fail();
    vi.mocked(logger.logDispatch).mockImplementation(diskLocked);
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    await run(walEntry(), { retries: 0 });
    expect(dlqMover).toHaveBeenCalledTimes(1);
  });

  it('a misconfigured subscriber is moved to the DLQ even when the logs fail', async () => {
    vi.mocked(logger.logDispatch).mockImplementation(diskLocked);
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    await run(walEntry(), { command: undefined });
    expect(dlqMover).toHaveBeenCalledTimes(1);
  });

  it('a successful delivery is acknowledged whatever the logs do', async () => {
    succeed();
    vi.mocked(logger.logDispatch).mockImplementation(diskLocked);
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    const entry = walEntry();
    await run(entry);
    expect(walUpdater).toHaveBeenCalledWith(entry.id, expect.objectContaining({ status: 'acked' }));
  });

  it('says once per cause that a log could not be written, in the diagnostic log, and what it did not affect', async () => {
    fail();
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    await run(walEntry());
    await run(walEntry());
    const said = vi.mocked(logger.logDiagnostic).mock.calls.map((c) => c[0]).filter((d) => d.message.includes('EBUSY'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ source: 'AsyncDispatcher', level: 'warn' });
    expect(said[0]!.message).toContain('history');
    expect(said[0]!.message).toContain('retry');
  });

  it('a diagnostic log that fails too reaches stderr instead of the dispatch', async () => {
    fail();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(history.logOutcome).mockImplementation(diskLocked);
    vi.mocked(logger.logDiagnostic).mockImplementation(diskLocked);
    await expect(run(walEntry())).resolves.toBeUndefined();
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('EBUSY');
  });
});

describe('AsyncDispatcher: the write that records the result of a delivery', () => {
  let logger: QueueLogWriter;
  let dispatcher: AsyncDispatcher;
  let writes: Array<{ id: string; updates: Partial<WalEntry> }>;
  let failing: number;
  const updater: WalUpdater = (id, updates) => {
    if (failing > 0) {
      failing--;
      throw new Error('EPERM: rename wal.ndjson');
    }
    writes.push({ id, updates });
  };

  beforeEach(() => {
    logger = { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
    writes = [];
    failing = 0;
    dispatcher = new AsyncDispatcher((id, updates) => updater(id, updates), vi.fn(), logger, { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  const messages = (): string[] => vi.mocked(logger.logDiagnostic).mock.calls.map((c) => c[0].message);

  it('is attempted again right away: a transient failure leaves the entry acknowledged', async () => {
    failing = 2;
    const entry = walEntry();
    await dispatcher.dispatch([sub()], envelope, new Map([['s1', entry]]));
    expect(writes).toEqual([{ id: entry.id, updates: expect.objectContaining({ status: 'acked' }) }]);
    expect(dispatcher.unrecordedCount).toBe(0);
  });

  it('when it keeps failing, says loudly that a delivered entry stays pending and may be delivered again, and keeps the ack to write later', async () => {
    failing = 1000;
    const entry = walEntry();
    await dispatcher.dispatch([sub()], envelope, new Map([['s1', entry]]));
    expect(dispatcher.unrecordedCount).toBe(1);
    const said = messages().find((m) => m.includes(entry.id));
    expect(said).toBeDefined();
    expect(said).toContain('EPERM');
    expect(said).toContain('delivered');
    expect(said).toContain('again');
  });

  it('retryUnrecorded writes the ack once the file is writable again, and the entry is no longer kept', async () => {
    failing = 1000;
    const entry = walEntry();
    await dispatcher.dispatch([sub()], envelope, new Map([['s1', entry]]));
    failing = 0;
    expect(dispatcher.retryUnrecorded()).toBe(0);
    expect(writes).toEqual([{ id: entry.id, updates: expect.objectContaining({ status: 'acked' }) }]);
    expect(dispatcher.unrecordedCount).toBe(0);
  });

  it('retryUnrecorded gives up after a bounded number of attempts and says the entry will be delivered again', async () => {
    failing = 1_000_000;
    const entry = walEntry();
    await dispatcher.dispatch([sub()], envelope, new Map([['s1', entry]]));
    let remaining = 1;
    let rounds = 0;
    while (remaining > 0 && rounds < 1000) {
      remaining = dispatcher.retryUnrecorded();
      rounds++;
    }
    expect(remaining).toBe(0);
    expect(rounds).toBeLessThan(1000);
    expect(messages().some((m) => m.includes(entry.id) && m.includes('gave up'))).toBe(true);
  });

  it('a failed delivery whose status write fails is still retried (the entry is pending, a retry can run it)', async () => {
    vi.mocked(CliTransport.prototype.dispatch).mockResolvedValue({ success: false, error: 'exit 1', durationMs: 1 });
    failing = 1000;
    const entry = walEntry();
    await dispatcher.dispatch([sub()], envelope, new Map([['s1', entry]]));
    expect(RetryScheduler.scheduleRetry).toHaveBeenCalledTimes(1);
  });
});

describe('AsyncDispatcher: the due time of a retry is written with the failure', () => {
  const NOW = Date.parse('2026-11-08T12:00:00.000Z');
  let walUpdater: ReturnType<typeof vi.fn> & WalUpdater;
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    walUpdater = vi.fn() as ReturnType<typeof vi.fn> & WalUpdater;
    dispatcher = new AsyncDispatcher(walUpdater, vi.fn(), { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() }, { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'exit 1', durationMs: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const due = (entry: WalEntry, overrides: Partial<ResolvedSubscriber>): Promise<void> => dispatcher.dispatch([sub(overrides)], envelope, new Map([['s1', entry]]));

  it('exponential: the failure that makes 2 attempts is retried after 4 minutes', async () => {
    const entry = { ...walEntry(), attempts: 1 };
    await due(entry, { retries: 10 });
    expect(walUpdater).toHaveBeenCalledWith(entry.id, expect.objectContaining({ attempts: 2, retryDueAt: new Date(NOW + 4 * 60_000).toISOString() }));
  });

  it('linear: the same failure is retried after 3 minutes', async () => {
    const entry = { ...walEntry(), attempts: 1 };
    await due(entry, { retries: 10, backoff: 'linear' });
    expect(walUpdater).toHaveBeenCalledWith(entry.id, expect.objectContaining({ retryDueAt: new Date(NOW + 3 * 60_000).toISOString() }));
  });

  it('the last attempt (it goes to the DLQ) carries no due time', async () => {
    const entry = walEntry();
    await due(entry, { retries: 1 });
    const updates = walUpdater.mock.calls[0]![1] as Partial<WalEntry>;
    expect(updates.status).toBe('failed');
    expect('retryDueAt' in updates).toBe(false);
  });

  it('a permanent failure carries no due time either', async () => {
    vi.mocked(CliTransport.prototype.dispatch).mockResolvedValue({ success: false, error: 'bad command', durationMs: 1, permanent: true });
    const entry = walEntry();
    await due(entry, { retries: 10 });
    expect('retryDueAt' in (walUpdater.mock.calls[0]![1] as object)).toBe(false);
  });
});
