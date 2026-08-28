import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncDispatcher } from './AsyncDispatcher.js';
import { CliTransport } from './CliTransport.js';
import type { WalEntry } from '../storage/Wal.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

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
  let dispatcher: AsyncDispatcher;

  beforeEach(() => {
    walUpdater = vi.fn() as unknown as (id: string, updates: Partial<WalEntry>) => void;
    dispatcher = new AsyncDispatcher(walUpdater);
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
});
