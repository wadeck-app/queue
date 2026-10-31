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

  it('aborts with the configProblem of an unknown action, without running anything', async () => {
    const run = vi.fn<ActionPlugin['run']>();
    const { dispatcher } = setup(run);

    const result = await dispatcher.dispatch([actionSub({ configProblem: 'unknown action "nope"' })], makeEnvelope(), 5000);

    expect(result).toEqual({ action: 'aborted', reason: 'unknown action "nope"' });
    expect(run).not.toHaveBeenCalled();
  });
});
