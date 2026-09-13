import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncDispatcher } from './AsyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import { MAX_CAPTURED_BYTES } from './OutputCapture.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

function makeLogger(): QueueLogWriter {
  return { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
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
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    dlqMover = vi.fn() as unknown as (entry: WalEntry, lastError: string) => void;
    logger = makeLogger();
    dispatcher = new AsyncDispatcher(walUpdater, dlqMover, logger);
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
  });

  it('failed subscriber → WAL status updated to failed', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'exit code 1', durationMs: 1 });

    const sub = makeSub('sub-1');
    const w = makeWalEntry('sub-1');
    const walEntries = new Map([['sub-1', w]]);

    await dispatcher.dispatch([sub], makeEnvelope(), walEntries);

    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed' }));
  });

  it('retries=0 + failure → dlqMover called immediately', async () => {
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
    // Simulate entry that has already failed twice (attempts=2 >= retries=2 → DLQ)
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
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    dlqMover = vi.fn() as unknown as (entry: WalEntry, lastError: string) => void;
    logger = makeLogger();
    dispatcher = new AsyncDispatcher(walUpdater, dlqMover, logger);
  });

  it('failed dispatch logs the child stdout and stderr', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: false,
      error: 'exited with code 3',
      stdout: 'starting…',
      stderr: "Cannot find module 'extension-points/extension-points.json'",
      durationMs: 7,
    });

    const w = makeWalEntry('sub-1');
    await dispatcher.dispatch([makeSub('sub-1')], makeEnvelope(), new Map([['sub-1', w]]));

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'exited with code 3',
      stdout: 'starting…',
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

  it("cli subscriber without command is logged as failed, not silently dropped", async () => {
    const sub: ResolvedSubscriber = { ...makeSub('sub-1'), command: undefined };
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([sub], makeEnvelope(), new Map([['sub-1', w]]));

    expect(walUpdater).toHaveBeenCalledWith(w.id, expect.objectContaining({ status: 'failed' }));
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      subscriberId: 'sub-1',
      status: 'failed',
      error: expect.stringContaining("type 'cli' but no 'command' field") as unknown as string,
    }));
  });

  it('http subscriber without url is logged as failed', async () => {
    const sub: ResolvedSubscriber = { ...makeSub('sub-1'), type: 'http', command: undefined, url: undefined };
    const w = makeWalEntry('sub-1');

    await dispatcher.dispatch([sub], makeEnvelope(), new Map([['sub-1', w]]));

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
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
