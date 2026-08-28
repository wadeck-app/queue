import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncDispatcher } from './SyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

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
    event: 'beforeTicket.create',
    type: 'cli',
    command,
    retries: 3,
    timeoutMs: 5000,
    backoff: 'exponential',
  };
}

describe('SyncDispatcher', () => {
  let dispatcher: SyncDispatcher;

  beforeEach(() => {
    dispatcher = new SyncDispatcher();
  });

  it('empty stdout → pass-through with original payload', async () => {
    vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    const result = await dispatcher.dispatch([makeSub('s1')], makeEnvelope(), 5000);
    expect(result.action).toBe('continue');
    expect(result.payload).toEqual({ title: 'original' });
  });

  it('invalid JSON on stdout → abort with reason', async () => {
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
  });

  it('timeout → abort with reason', async () => {
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
