import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncDispatcher } from './AsyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import { ActionTransport } from './ActionTransport.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
import { RetryScheduler } from './RetryScheduler.js';
import { MAX_CAPTURED_BYTES } from './OutputCapture.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

function makeLogger(): QueueLogWriter {
  return { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
}

function makeHistoryLog(): HistoryWriter {
  return { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() };
}

function makeEnvelope(): EventEnvelope {
  return {
    id: 'env-id',
    timestamp: '2026-01-01T00:00:00.000Z',
    event: 'onTicket.created',
    payload: { title: 'test' },
    meta: { cwd: '/tmp' },
  };
}

function makeSub(id: string): ResolvedSubscriber {
  return {
    subscriberId: id,
    name: id,
    file: "subscribers.yml",
    scope: "global",
    event: 'onTicket.created',
    type: 'cli',
    command: 'echo ok',
    retries: 3,
    timeoutMs: 5000,
    backoff: 'exponential',
  };
}

function makeWalEntry(subscriberId: string): WalEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: 'onTicket.created',
    payload: {},
    meta: { cwd: '/tmp' },
    subscriberId,
    status: 'pending',
    attempts: 0,
  };
}

describe('AsyncDispatcher', () => {
  let walUpdater: (id: string, updates: Partial<WalEntry>) => void;
  let dlqMover: (entry: WalEntry, lastError: string) => void;
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    dlqMover = vi.fn() as unknown as (entry: WalEntry, lastError: string) => void;
    logger = makeLogger();
    historyLog = makeHistoryLog();
    dispatcher = new AsyncDispatcher(walUpdater, dlqMover, logger, historyLog);
  });

  it('parallel dispatch: both subscribers called', async () => {
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });

    const sub1 = makeSub('sub-1');
    const sub2 = makeSub('sub-2');
    const w1 = makeWalEntry('sub-1');
    const w2 = makeWalEntry('sub-2');
    const walEntries = new Map([['sub-1', w1], ['sub-2', w2]]);

    await dispatcher.dispatch([sub1, sub2], makeEnvelope(), walEntries);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(walUpdater).toHaveBeenCalledWith(w1.id, expect.objectContaining({ status: 'acked' }));
    expect(walUpdater).toHaveBeenCalledWith(w2.id, expect.objectContaining({ status: 'acked' }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'onTicket.created', subscriberId: 'sub-1', status: 'success', target: 'echo ok' });
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'onTicket.created', subscriberId: 'sub-2', status: 'success', target: 'echo ok' });
  });

  it('failed subscriber: WAL status updated to failed', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'exit code 1', durationMs: 1 });

    const sub = makeSub('sub-1');
    const w = makeWalEntry('sub-1');
    const walEntries = new Map([['sub-1', w]]);

    await dispatcher.dispatch([sub], makeEnvelope(), walEntries);

    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed' }));
  });

  it('retries=0 + failure: dlqMover called immediately', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'exit code 1', durationMs: 1 });

    const sub = { ...makeSub('sub-1'), retries: 0 };
    const w = makeWalEntry('sub-1');
    const walEntries = new Map([['sub-1', w]]);

    await dispatcher.dispatch([sub], makeEnvelope(), walEntries);

    expect(dlqMover).toHaveBeenCalledTimes(1);
    expect(dlqMover).toHaveBeenCalledWith(
      expect.objectContaining({ id: w.id, attempts: 1 }),
      'exit code 1',
    );
  });

  it('retries=2: dlqMover not called on first failure', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'err', durationMs: 1 });

    const sub = { ...makeSub('sub-1'), retries: 2 };
    const w = makeWalEntry('sub-1');
    const walEntries = new Map([['sub-1', w]]);

    await dispatcher.dispatch([sub], makeEnvelope(), walEntries);

    expect(dlqMover).not.toHaveBeenCalled();
  });

  it('retries=2: dlqMover called when attempts reach retries', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'err', durationMs: 1 });

    const sub = { ...makeSub('sub-1'), retries: 2 };
    // Simulate entry that has already failed twice (attempts=2 >= retries=2, moves to DLQ)
    const w = { ...makeWalEntry('sub-1'), attempts: 2 };
    const walEntries = new Map([['sub-1', w]]);

    await dispatcher.dispatch([sub], makeEnvelope(), walEntries);

    expect(dlqMover).toHaveBeenCalledTimes(1);
    expect(dlqMover).toHaveBeenCalledWith(
      expect.objectContaining({ id: w.id, attempts: 3 }),
      'err',
    );
  });
});

describe('AsyncDispatcher - diagnosability', () => {
  let walUpdater: (id: string, updates: Partial<WalEntry>) => void;
  let dlqMover: (entry: WalEntry, lastError: string) => void;
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    dlqMover = vi.fn() as unknown as (entry: WalEntry, lastError: string) => void;
    logger = makeLogger();
    historyLog = makeHistoryLog();
    dispatcher = new AsyncDispatcher(walUpdater, dlqMover, logger, historyLog);
  });

  it('failed dispatch logs the child stdout and stderr', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: false,
      error: 'exited with code 3',
      stdout: 'starting...',
      stderr: "Cannot find module 'extension-points/extension-points.json'",
      durationMs: 7,
    });

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([makeSub('sub-1')], makeEnvelope(), new Map([['sub-1', w]]));

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'exited with code 3',
      stdout: 'starting...',
      stderr: "Cannot find module 'extension-points/extension-points.json'",
    }));
  });

  it('dlq dispatch logs the child stderr', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: false, error: 'exited with code 3', stderr: 'Daemon did not start within 10000ms', durationMs: 1,
    });

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([{ ...makeSub('sub-1'), retries: 0 }], makeEnvelope(), new Map([['sub-1', w]]));

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'dlq',
      stderr: 'Daemon did not start within 10000ms',
    }));
  });

  it('chatty failing subscriber output is truncated with a marker', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: false, error: 'exited with code 1', stderr: 'n'.repeat(MAX_CAPTURED_BYTES * 2), durationMs: 1,
    });

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([makeSub('sub-1')], makeEnvelope(), new Map([['sub-1', w]]));

    const entry = vi.mocked(logger.logDispatch).mock.calls[0]![0];
    expect(entry.stderr).toContain('[truncated: kept last');
    expect(entry.stderr!.length).toBeLessThan(MAX_CAPTURED_BYTES + 100);
  });

  it('successful dispatch keeps a non-empty stderr but drops stdout', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: true, stdout: 'lots of output', stderr: 'deprecation warning', durationMs: 1,
    });

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([makeSub('sub-1')], makeEnvelope(), new Map([['sub-1', w]]));

    const entry = vi.mocked(logger.logDispatch).mock.calls[0]![0];
    expect(entry.status).toBe('success');
    expect(entry.stderr).toBe('deprecation warning');
    expect(entry.stdout).toBeUndefined();
  });

  it("cli subscriber without command goes straight to the DLQ with the reason, not silently dropped", async () => {
    const sub: ResolvedSubscriber = { ...makeSub('sub-1'), command: undefined };
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([sub], makeEnvelope(), new Map([['sub-1', w]]));

    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed' }));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      subscriberId: 'sub-1',
      status: 'dlq',
      error: expect.stringContaining("type 'cli' but no 'command' field") as unknown as string,
    }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'onTicket.created', subscriberId: 'sub-1', status: 'dlq' });
  });

  it('cli subscriber that has no folder to run from (virtual project) fails with the reason, and its command is not run', async () => {
    const spawned = vi.spyOn(CliTransport.prototype, 'dispatch');
    const sub: ResolvedSubscriber = { ...makeSub('sub-1'), cwd: '', cwdProblem: "subscriber 'x' belongs to the virtual project 'v'" };
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([sub], makeEnvelope(), new Map([['sub-1', w]]));

    expect(spawned).not.toHaveBeenCalled();
    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed' }));
    expect(dlqMover).toHaveBeenCalledWith(expect.objectContaining({ id: w.id, attempts: 1 }), expect.stringContaining("virtual project 'v'"));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'dlq',
      error: expect.stringContaining("virtual project 'v'") as unknown as string,
    }));
  });

  it('files every outcome under the project of the dispatch, and the emitter for a descendant', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    const envelope = makeEnvelope();
    const descendant = { ...envelope, meta: { ...envelope.meta, projectId: 'bbbbbbbb', emitterProjectId: 'aaaaaaaa' } };

    await dispatcher.dispatch([makeSub('sub-1')], descendant, new Map([['sub-1', makeWalEntry('sub-1')]]));

    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ subscriberId: 'sub-1', status: 'success', projectId: 'bbbbbbbb', emitterProjectId: 'aaaaaaaa' }));
  });

  it('http subscriber without url goes straight to the DLQ with the reason', async () => {
    const sub: ResolvedSubscriber = { ...makeSub('sub-1'), type: 'http', command: undefined, url: undefined };
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([sub], makeEnvelope(), new Map([['sub-1', w]]));

    expect(dlqMover).toHaveBeenCalledWith(expect.objectContaining({ id: w.id }), expect.stringContaining("type 'http' but no 'url' field"));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'dlq',
      error: expect.stringContaining("type 'http' but no 'url' field") as unknown as string,
    }));
  });

  it('missing WAL entry is logged as a diagnostic instead of stderr', async () => {
    await dispatcher.dispatch([makeSub('sub-1')], makeEnvelope(), new Map());

    expect(logger.logDiagnostic).toHaveBeenCalledWith({
      source: 'AsyncDispatcher',
      message: expect.stringContaining('no WAL entry for subscriber sub-1') as unknown as string,
    });
  });
});

describe('AsyncDispatcher - permanent failure', () => {
  it('moves a permanent failure to the DLQ on the first attempt even when retries remain, without scheduling a retry', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'refused value', permanent: true, durationMs: 1 });
    const walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    const dlqMover = vi.fn() as unknown as (entry: WalEntry, lastError: string) => void;
    const dispatcher = new AsyncDispatcher(walUpdater, dlqMover, makeLogger(), makeHistoryLog());

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([{ ...makeSub('sub-1'), retries: 5 }], makeEnvelope(), new Map([['sub-1', w]]));

    expect(dlqMover).toHaveBeenCalledWith(expect.objectContaining({ id: w.id, attempts: 1 }), 'refused value');
  });
});

describe('AsyncDispatcher - type action', () => {
  function actionSub(overrides: Partial<ResolvedSubscriber> = {}): ResolvedSubscriber {
    return { ...makeSub('sub-1'), type: 'action', command: undefined, action: 'probe', with: { a: 1 }, ...overrides };
  }

  function setup(run: ActionPlugin['run']): { dispatcher: AsyncDispatcher; walUpdater: ReturnType<typeof vi.fn>; dlqMover: ReturnType<typeof vi.fn>; logger: QueueLogWriter; historyLog: HistoryWriter } {
    const walUpdater = vi.fn();
    const dlqMover = vi.fn();
    const logger = makeLogger();
    const historyLog = makeHistoryLog();
    const plugin: ActionPlugin = { name: 'probe', validate: () => undefined, run };
    const transport = new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }));
    const dispatcher = new AsyncDispatcher(walUpdater as never, dlqMover as never, logger, historyLog, transport);
    return { dispatcher, walUpdater, dlqMover, logger, historyLog };
  }

  it('never reaches the cli or the http transport, runs the plugin with its configuration and acks', async () => {
    const http = vi.spyOn(HttpTransport.prototype, 'dispatch');
    const cli = vi.spyOn(CliTransport.prototype, 'dispatch');
    const run = vi.fn<ActionPlugin['run']>().mockResolvedValue({ success: true, detail: "emitted 'x'" });
    const { dispatcher, walUpdater, logger, historyLog } = setup(run);
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub()], makeEnvelope(), new Map([['sub-1', w]]));

    expect(http).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith({ a: 1 }, expect.anything(), expect.anything());
    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'acked' }));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', target: 'action:probe', detail: "emitted 'x'" }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', target: 'action:probe' }));
  });

  it('a permanent failure goes to the DLQ on the first attempt even with retries left, without scheduling a retry', async () => {
    const scheduler = vi.spyOn(RetryScheduler, 'scheduleRetry');
    const { dispatcher, dlqMover, historyLog } = setup(() => Promise.resolve({ success: false, error: 'refused value', permanent: true }));
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub({ retries: 5 })], makeEnvelope(), new Map([['sub-1', w]]));

    expect(dlqMover).toHaveBeenCalledWith(expect.objectContaining({ id: w.id, attempts: 1 }), 'refused value');
    expect(scheduler).not.toHaveBeenCalled();
    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'dlq', target: 'action:probe' }));
  });

  it('a plugin that throws is retried (a retry is scheduled, no DLQ) while retries remain', async () => {
    const scheduler = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const { dispatcher, dlqMover, walUpdater } = setup(() => Promise.reject(new Error('boom')));
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub({ retries: 5 })], makeEnvelope(), new Map([['sub-1', w]]));

    expect(dlqMover).not.toHaveBeenCalled();
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed', lastError: expect.stringContaining('boom') as unknown as string }));
  });

  it('honours the timeout of the subscriber', async () => {
    const scheduler = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const { dispatcher, walUpdater } = setup(() => new Promise(() => undefined));
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub({ timeoutMs: 30, retries: 5 })], makeEnvelope(), new Map([['sub-1', w]]));

    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ lastError: expect.stringMatching(/^timeout after/) as unknown as string }));
    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it('a subscriber with a configProblem (unknown action) goes straight to the DLQ with the loud message and never runs', async () => {
    const run = vi.fn<ActionPlugin['run']>();
    const { dispatcher, dlqMover, logger } = setup(run);
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub({ action: 'nope', configProblem: 'unknown action "nope". Available actions: emit' })], makeEnvelope(), new Map([['sub-1', w]]));

    expect(run).not.toHaveBeenCalled();
    expect(dlqMover).toHaveBeenCalledWith(expect.objectContaining({ id: w.id, attempts: 1 }), expect.stringContaining('unknown action "nope"'));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'dlq', target: 'action:nope' }));
  });

  it('fails for good, saying so, when this process has no action transport', async () => {
    const walUpdater = vi.fn();
    const dlqMover = vi.fn();
    const dispatcher = new AsyncDispatcher(walUpdater as never, dlqMover as never, makeLogger(), makeHistoryLog());
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([actionSub()], makeEnvelope(), new Map([['sub-1', w]]));

    expect(dlqMover).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('runs no actions'));
  });
});
