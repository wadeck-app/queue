import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncDispatcher } from './SyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import { ActionTransport } from './ActionTransport.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
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
    event: 'beforeTicket.create',
    payload: { title: 'original' },
    meta: { cwd: '/tmp' },
  };
}

function makeSub(id: string, command = 'echo ok'): ResolvedSubscriber {
  return {
    subscriberId: id,
    name: id,
    file: "subscribers.yml",
    scope: "global",
    event: 'beforeTicket.create',
    type: 'cli',
    command,
    retries: 3,
    timeoutMs: 5000,
    backoff: 'exponential',
  };
}

describe('SyncDispatcher', () => {
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dispatcher: SyncDispatcher;

  beforeEach(() => {
    logger = makeLogger();
    historyLog = makeHistoryLog();
    dispatcher = new SyncDispatcher(logger, historyLog);
  });

  it('empty stdout: pass-through with original payload', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ title: 'original' });
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'beforeTicket.create', subscriberId: 's1', status: 'success', target: 'echo ok' });
  });

  it('invalid JSON on stdout: abort with reason', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: 'not-json', durationMs: 1 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);
    expect(result.action).toBe('aborted');
    expect(result.reason).toContain('invalid JSON');
  });

  it('abort action stops chain', async () => {
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch')
      .mockResolvedValueOnce({ success: true, stdout: JSON.stringify({ action: 'abort', reason: 'nope' }), durationMs: 1 })
      .mockResolvedValueOnce({ success: true, stdout: '', durationMs: 1 });

    const result = await dispatcher.dispatch([makeSub('s1'), makeSub('s2')], makeEnvelope(), 5000);
    expect(result.action).toBe('aborted');
    expect(result.reason).toBe('nope');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'beforeTicket.create', subscriberId: 's1', status: 'success', target: 'echo ok' });
  });

  it('timeout: abort with reason', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'timeout after 5s', durationMs: 5000 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);
    expect(result.action).toBe('aborted');
    expect(result.reason).toContain('timeout');
  });

  it.each([
    [30, 'subscriber timeout after 30ms'],
    [999, 'subscriber timeout after 999ms'],
    [1200, 'subscriber timeout after 1.2s'],
    [5000, 'subscriber timeout after 5s'],
  ])('timeout of %i ms is printed as "%s" (milliseconds under one second, never rounded to 0s)', async (timeoutMs, expected) => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'timeout after whatever', durationMs: 1 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), timeoutMs);
    expect(result.reason).toBe(expected);
  });

  it('successful waterfall: each subscriber gets previous response payload', async () => {
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch')
      .mockResolvedValueOnce({ success: true, stdout: JSON.stringify({ action: 'continue', payload: { title: 'modified' } }), durationMs: 1 })
      .mockResolvedValueOnce({ success: true, stdout: JSON.stringify({ action: 'continue', payload: { title: 'final' } }), durationMs: 1 });

    const result = await dispatcher.dispatch([makeSub('s1'), makeSub('s2')], makeEnvelope(), 5000);
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ title: 'final' });
    expect(spy).toHaveBeenCalledTimes(2);
    const secondCallArg = spy.mock.calls[1]![1] as EventEnvelope;
    expect(secondCallArg.payload).toEqual({ title: 'modified' });
  });
});

describe('SyncDispatcher - diagnosability', () => {
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dispatcher: SyncDispatcher;

  beforeEach(() => {
    logger = makeLogger();
    historyLog = makeHistoryLog();
    dispatcher = new SyncDispatcher(logger, historyLog);
  });

  it('failed dispatch persists stdout and stderr, not only the abort reason', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({
      success: false, error: 'exited with code 3', stdout: 'checking...', stderr: 'Daemon did not start within 10000ms', durationMs: 3,
    });

    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);

    expect(result.action).toBe('aborted');
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      event: 'beforeTicket.create',
      subscriberId: 's1',
      status: 'failed',
      error: 'exited with code 3',
      stdout: 'checking...',
      stderr: 'Daemon did not start within 10000ms',
    }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'beforeTicket.create', subscriberId: 's1', status: 'failed', target: 'echo ok' });
  });

  it('invalid JSON abort persists the offending stdout', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: 'not-json', durationMs: 1 });

    await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'subscriber returned invalid JSON',
      stdout: 'not-json',
    }));
  });

  it('cli subscriber that has no folder to run from (virtual project) aborts with the reason, and its command is not run', async () => {
    const spawned = vi.spyOn(CliTransport.prototype, 'dispatch');
    const sub: ResolvedSubscriber = { ...makeSub('s1'), cwd: '', cwdProblem: "subscriber 'x' belongs to the virtual project 'v'" };

    const result = await dispatcher.dispatch([sub], makeEnvelope(), 5000);

    expect(spawned).not.toHaveBeenCalled();
    expect(result.reason).toContain("virtual project 'v'");
  });

  it('cli subscriber without command aborts with an actionable reason and is logged', async () => {
    const sub: ResolvedSubscriber = { ...makeSub('s1'), command: undefined };

    const result = await dispatcher.dispatch([sub], makeEnvelope(), 5000);

    expect(result.reason).toContain("type 'cli' but no 'command' field");
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('success with empty stderr logs nothing to the verbose log, but is still recorded in history', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', stderr: '', durationMs: 1 });

    await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);

    expect(logger.logDispatch).not.toHaveBeenCalled();
    expect(historyLog.logOutcome).toHaveBeenCalledWith({ eventId: 'env-id', event: 'beforeTicket.create', subscriberId: 's1', status: 'success', target: 'echo ok' });
  });

  it('success with a non-empty stderr is recorded', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', stderr: 'warning: deprecated flag', durationMs: 1 });

    await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);

    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      stderr: 'warning: deprecated flag',
    }));
  });
});

describe('SyncDispatcher - type action', () => {
  function actionSub(overrides: Partial<ResolvedSubscriber> = {}): ResolvedSubscriber {
    return { ...makeSub('sub-1'), type: 'action', command: undefined, action: 'probe', with: {}, ...overrides };
  }

  function setup(run: ActionPlugin['run']): { dispatcher: SyncDispatcher; logger: QueueLogWriter; historyLog: HistoryWriter } {
    const logger = makeLogger();
    const historyLog = makeHistoryLog();
    const plugin: ActionPlugin = { name: 'probe', validate: () => undefined, run };
    const transport = new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }));
    return { dispatcher: new SyncDispatcher(logger, historyLog, transport), logger, historyLog };
  }

  it('passes an action through: the payload is untouched, nothing is parsed as JSON, the detail is logged and never reaches cli or http', async () => {
    const http = vi.spyOn(HttpTransport.prototype, 'dispatch');
    const cli = vi.spyOn(CliTransport.prototype, 'dispatch');
    const { dispatcher, logger, historyLog } = setup(() => Promise.resolve({ success: true, detail: 'it was done' }));

    const result = await dispatcher.dispatch([actionSub()], makeEnvelope(), 5000);

    expect(result).toEqual({ action: 'continue', payload: { title: 'original' } });
    expect(http).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', target: 'action:probe', detail: 'it was done' }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', target: 'action:probe' }));
  });

  it('aborts the chain with the reason when the action fails', async () => {
    const { dispatcher, historyLog } = setup(() => Promise.resolve({ success: false, error: 'nope', permanent: true }));

    const result = await dispatcher.dispatch([actionSub()], makeEnvelope(), 5000);

    expect(result).toEqual({ action: 'aborted', reason: 'nope' });
    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', target: 'action:probe' }));
  });

  it('keeps the detail of a failed action in the log of the abort', async () => {
    const { dispatcher, logger } = setup(() => Promise.resolve({ success: false, error: 'nope', detail: 'sent 1 of 2' }));
    await dispatcher.dispatch([actionSub()], makeEnvelope(), 5000);
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', detail: 'sent 1 of 2' }));
  });

  it('aborts with the configProblem of an unknown action, without running anything', async () => {
    const run = vi.fn<ActionPlugin['run']>();
    const { dispatcher } = setup(run);

    const result = await dispatcher.dispatch([actionSub({ configProblem: 'unknown action "nope"' })], makeEnvelope(), 5000);

    expect(result).toEqual({ action: 'aborted', reason: 'unknown action "nope"' });
    expect(run).not.toHaveBeenCalled();
  });
});

// `timeout` of a before* push is the time of the WHOLE event: the subscribers share it, they do not each get the full value
describe('SyncDispatcher: the timeout is one budget for the whole before* phase', () => {
  const clock = { now: 0 };
  let logger: QueueLogWriter;
  let historyLog: HistoryWriter;
  let dispatcher: SyncDispatcher;

  beforeEach(() => {
    clock.now = 0;
    logger = makeLogger();
    historyLog = makeHistoryLog();
    dispatcher = new SyncDispatcher(logger, historyLog, undefined, undefined, () => clock.now);
  });

  const each = (ms: number) => vi.spyOn(CliTransport.prototype, 'dispatch').mockImplementation(() => {
    clock.now += ms;
    return Promise.resolve({ success: true, stdout: '', durationMs: ms });
  });

  it('each subscriber gets what is left of the budget, the first one all of it', async () => {
    const spy = each(4000);
    const result = await dispatcher.dispatch([makeSub('s1'), makeSub('s2'), makeSub('s3')], makeEnvelope(), 10_000);
    expect(result.action).toBe('continue');
    expect(spy.mock.calls.map((call) => call[2])).toEqual([10_000, 6_000, 2_000]);
  });

  it('aborts, naming the subscriber that did not run and the budget, once the budget is spent; the next subscribers do not run', async () => {
    const spy = each(4000);
    const result = await dispatcher.dispatch([makeSub('s1'), makeSub('s2'), makeSub('s3'), makeSub('s4')], makeEnvelope(), 10_000);
    expect(result.action).toBe('aborted');
    expect(result.reason).toContain('s4');
    expect(result.reason).toContain('10s');
    expect(result.reason).toContain('whole');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(logger.logDispatch).toHaveBeenCalledWith(expect.objectContaining({ subscriberId: 's4', status: 'failed', error: result.reason }));
    expect(historyLog.logOutcome).toHaveBeenCalledWith(expect.objectContaining({ subscriberId: 's4', status: 'failed' }));
  });

  it('a budget with exactly nothing left does not start the subscriber', async () => {
    const spy = each(5000);
    const result = await dispatcher.dispatch([makeSub('s1'), makeSub('s2')], makeEnvelope(), 5_000);
    expect(result.action).toBe('aborted');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a single subscriber keeps the message it always had when it times out', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: false, error: 'timeout after 5s', durationMs: 5000 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5_000);
    expect(result.reason).toBe('subscriber timeout after 5s');
  });
});
