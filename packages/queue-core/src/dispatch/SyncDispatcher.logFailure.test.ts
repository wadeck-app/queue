/**
 * A log write (daemon log or history) never decides the outcome of a before* event, and never throws into the push: a day file locked by an antivirus
 * used to turn a successful chain into a failed push (the exception left dispatch()), or hide the reason a subscriber aborted. Same rule as AsyncDispatcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncDispatcher } from './SyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

const envelope: EventEnvelope = { id: 'env', timestamp: '2026-01-01T00:00:00.000Z', event: 'beforeX', payload: { n: 1 }, meta: { cwd: '/tmp' } };

function sub(id: string): ResolvedSubscriber {
  return { subscriberId: id, name: id, file: 'subscribers.yml', scope: 'global', event: 'beforeX', type: 'cli', command: 'echo ok', retries: 3, timeoutMs: 5000, backoff: 'exponential' };
}

const locked = (): never => {
  throw new Error('EBUSY: resource busy or locked, open the day file');
};

describe('SyncDispatcher: a log failure never decides the outcome', () => {
  let logger: QueueLogWriter;
  let history: HistoryWriter;
  let dispatcher: SyncDispatcher;

  beforeEach(() => {
    logger = { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
    history = { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() };
    dispatcher = new SyncDispatcher(logger, history);
  });
  afterEach(() => vi.restoreAllMocks());

  const cli = (...results: Array<{ success: boolean; stdout?: string; stderr?: string; error?: string }>): void => {
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch');
    for (const result of results) spy.mockResolvedValueOnce({ durationMs: 1, ...result });
  };

  it.each([
    ['the history', () => vi.mocked(history.logOutcome).mockImplementation(locked)],
    ['the dispatch log', () => vi.mocked(logger.logDispatch).mockImplementation(locked)],
  ])('a successful chain stays a success when %s cannot be written (stderr on success is logged: both paths run)', async (_what, breakIt) => {
    breakIt();
    cli({ success: true, stdout: JSON.stringify({ payload: { n: 2 } }), stderr: 'a hint' }, { success: true, stdout: '', stderr: 'another hint' });
    await expect(dispatcher.dispatch([sub('s1'), sub('s2')], envelope, 5000)).resolves.toEqual({ action: 'continue', payload: { n: 2 } });
  });

  it('a subscriber that aborts is still reported as aborted, with its own reason, when the history cannot be written', async () => {
    vi.mocked(history.logOutcome).mockImplementation(locked);
    cli({ success: true, stdout: JSON.stringify({ action: 'abort', reason: 'nope' }) });
    await expect(dispatcher.dispatch([sub('s1')], envelope, 5000)).resolves.toEqual({ action: 'aborted', reason: 'nope' });
  });

  it.each([
    ['the subscriber fails', { success: false, error: 'exit code 2' }, 'exit code 2'],
    ['it returns invalid JSON', { success: true, stdout: 'not-json' }, 'invalid JSON'],
  ])('when %s and neither log can be written, the abort keeps its reason', async (_what, result, reason) => {
    vi.mocked(history.logOutcome).mockImplementation(locked);
    vi.mocked(logger.logDispatch).mockImplementation(locked);
    cli(result);
    const outcome = await dispatcher.dispatch([sub('s1')], envelope, 5000);
    expect(outcome.action).toBe('aborted');
    expect(outcome.reason).toContain(reason);
  });

  it('the abort for a used-up budget keeps its reason when the logs cannot be written', async () => {
    vi.mocked(history.logOutcome).mockImplementation(locked);
    vi.mocked(logger.logDispatch).mockImplementation(locked);
    let now = 0;
    const timed = new SyncDispatcher(logger, history, undefined, undefined, () => now);
    vi.spyOn(CliTransport.prototype, 'dispatch').mockImplementation(async () => {
      now += 10_000;
      return { success: true, stdout: '', durationMs: 1 };
    });
    const outcome = await timed.dispatch([sub('s1'), sub('s2')], envelope, 5000);
    expect(outcome.action).toBe('aborted');
    expect(outcome.reason).toContain('s2');
  });

  it('says the failure once per cause in the daemon log, not on every subscriber, and names what to check', async () => {
    vi.mocked(history.logOutcome).mockImplementation(locked);
    cli({ success: true, stdout: '' }, { success: true, stdout: '' }, { success: true, stdout: '' });
    await dispatcher.dispatch([sub('s1'), sub('s2'), sub('s3')], envelope, 5000);
    const said = vi.mocked(logger.logDiagnostic).mock.calls.map(([line]) => line);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ source: 'SyncDispatcher', level: 'warn' });
    expect(said[0]!.message).toContain('history');
    expect(said[0]!.message).toContain('EBUSY');
    expect(said[0]!.message).toContain('Check that nothing locks the logs and history folders');
  });

  it('falls back to stderr when the daemon log is the one that cannot be written, and still returns the result', async () => {
    vi.mocked(history.logOutcome).mockImplementation(locked);
    vi.mocked(logger.logDiagnostic).mockImplementation(locked);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cli({ success: true, stdout: '' });
    await expect(dispatcher.dispatch([sub('s1')], envelope, 5000)).resolves.toEqual({ action: 'continue', payload: { n: 1 } });
    expect(write.mock.calls.map(([text]) => String(text)).join('')).toContain('[queue] SyncDispatcher:');
  });
});
