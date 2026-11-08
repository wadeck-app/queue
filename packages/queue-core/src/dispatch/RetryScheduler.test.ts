import { describe, it, expect, vi, afterEach } from 'vitest';
import { RetryScheduler, computeBackoff, type SchedulerDeps } from './RetryScheduler.js';
import type { WalEntry } from '../storage/Wal.js';

function entry(overrides: Partial<WalEntry> = {}): WalEntry {
  return { id: 'wal-1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onX', payload: {}, meta: {}, subscriberId: 's', status: 'failed', attempts: 0, ...overrides };
}

const original = RetryScheduler.deps;
afterEach(() => {
  RetryScheduler.deps = original;
});

function fakeDeps(overrides: Partial<SchedulerDeps> = {}): { deps: SchedulerDeps; sync: ReturnType<typeof vi.fn>; async: ReturnType<typeof vi.fn> } {
  const sync = vi.fn();
  const async = vi.fn();
  const deps: SchedulerDeps = { findOrch: () => '/bin/orch', randomSuffix: () => 'r4nd', runSync: sync, runAsync: async, ...overrides };
  RetryScheduler.deps = deps;
  return { deps, sync, async };
}

describe('computeBackoff', () => {
  it.each([
    [0, '1m'], [1, '2m'], [2, '4m'], [3, '8m'], [4, '16m'], [5, '16m'], [50, '16m'],
  ])('exponential, %i failed attempts: %s', (attempts, expected) => {
    expect(computeBackoff(attempts, 'exponential')).toBe(expected);
    expect(computeBackoff(attempts)).toBe(expected);
  });

  // linear: one more minute per failed attempt, same 16 minute ceiling as exponential
  it.each([
    [0, '1m'], [1, '2m'], [2, '3m'], [3, '4m'], [9, '10m'], [14, '15m'], [15, '16m'], [16, '16m'], [100, '16m'],
  ])('linear, %i failed attempts: %s', (attempts, expected) => {
    expect(computeBackoff(attempts, 'linear')).toBe(expected);
  });

  it('a negative or fractional attempt count is treated as the first step, never as an invalid delay', () => {
    expect(computeBackoff(-3, 'exponential')).toBe('1m');
    expect(computeBackoff(-3, 'linear')).toBe('1m');
  });
});

describe('RetryScheduler.scheduleRetry', () => {
  it('asks orch for a one-shot job that runs the retry of this entry after the backoff of its attempts', () => {
    const { async } = fakeDeps();
    RetryScheduler.scheduleRetry(entry({ id: 'abc', attempts: 3 }));
    expect(async).toHaveBeenCalledTimes(1);
    expect(async.mock.calls[0]![0]).toBe('/bin/orch');
    expect(async.mock.calls[0]![1]).toEqual(['add', '--once', 'queue-retry-abc-3-r4nd', '--delay', '8m', '--command', 'queue retry --event abc']);
  });

  // Checked against the installed orch: "orch add --once --delay 2m 'queue retry --event x'" (no id, no --command) exits 4 and creates nothing, so no retry was ever scheduled
  it('gives orch an id and a --command, the two things it requires, and an id made only of letters, digits and "-"', () => {
    const { async } = fakeDeps({ randomSuffix: () => 'ab12' });
    RetryScheduler.scheduleRetry(entry({ id: 'we/ird id.7', attempts: 2 }));
    const args = async.mock.calls[0]![1] as string[];
    expect(args.slice(0, 2)).toEqual(['add', '--once']);
    expect(args[2]).toMatch(/^[a-z0-9-]+$/i);
    expect(args.indexOf('--command')).toBeGreaterThan(2);
    expect(args[args.indexOf('--command') + 1]).toBe('queue retry --event we/ird id.7');
  });

  it('the job id differs per call, so a one-shot job that already fired never makes the next schedule a duplicate', () => {
    const real = RetryScheduler.deps;
    const { async } = fakeDeps({ randomSuffix: real.randomSuffix });
    RetryScheduler.scheduleRetry(entry());
    RetryScheduler.scheduleRetry(entry());
    expect((async.mock.calls[0]![1] as string[])[2]).not.toBe((async.mock.calls[1]![1] as string[])[2]);
  });

  it('honours the backoff strategy of the subscriber', () => {
    const { async } = fakeDeps();
    RetryScheduler.scheduleRetry(entry({ attempts: 3 }), false, { backoff: 'linear' });
    expect(async.mock.calls[0]![1]).toContain('4m');
  });

  it('the shutdown path waits for orch (sync) and does not use the asynchronous call', () => {
    const { sync, async } = fakeDeps();
    RetryScheduler.scheduleRetry(entry({ attempts: 1 }), true);
    expect(async).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]![1]).toEqual(['add', '--once', 'queue-retry-wal-1-1-r4nd', '--delay', '2m', '--command', 'queue retry --event wal-1']);
  });

  it('a missing orch throws a message that says how to fix it, and nothing is spawned', () => {
    const { sync, async } = fakeDeps({ findOrch: () => null });
    expect(() => RetryScheduler.scheduleRetry(entry())).toThrow(/orch not found on PATH.*Install @wadeck\/orchestrator/s);
    expect(sync).not.toHaveBeenCalled();
    expect(async).not.toHaveBeenCalled();
  });

  it('a failure of orch on the sync path throws with the entry, orch output and the way to retry by hand', () => {
    fakeDeps({ runSync: () => { throw Object.assign(new Error('Command failed'), { stderr: Buffer.from('orch: daemon not running') }); } });
    expect(() => RetryScheduler.scheduleRetry(entry({ id: 'abc' }), true)).toThrow(/abc.*orch: daemon not running.*queue retry --event abc/s);
  });

  it('a spawn failure on the async path goes to onError (never to a stderr nobody reads) with the same facts', () => {
    const { async } = fakeDeps();
    const onError = vi.fn();
    RetryScheduler.scheduleRetry(entry({ id: 'abc' }), false, { onError });
    const callback = async.mock.calls[0]![2] as (err: Error | null, stdout: string, stderr: string) => void;
    callback(Object.assign(new Error('spawn orch ENOENT'), { code: 'ENOENT' }), '', 'boom');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]![0] as Error).message)).toMatch(/abc.*ENOENT.*boom.*queue retry --event abc/s);
  });

  it('a successful orch call reports nothing', () => {
    const { async } = fakeDeps();
    const onError = vi.fn();
    RetryScheduler.scheduleRetry(entry(), false, { onError });
    (async.mock.calls[0]![2] as (err: Error | null) => void)(null);
    expect(onError).not.toHaveBeenCalled();
  });
});
