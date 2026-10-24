import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerWaiter, unregisterWaiter, liveWaiterCount, markOnDemand, pinRelay, isOnDemand, startIdleWatchdog } from './onDemand.js';

let relayDir: string;

beforeEach(() => {
  relayDir = mkdtempSync(join(tmpdir(), 'relay-on-demand-'));
});

afterEach(() => {
  rmSync(relayDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('waiters registry', () => {
  it('counts the waiters whose process is alive', () => {
    registerWaiter(relayDir, 101);
    registerWaiter(relayDir, 102);
    expect(liveWaiterCount(relayDir, () => true)).toBe(2);
  });

  it('forgets a waiter that unregistered', () => {
    registerWaiter(relayDir, 101);
    unregisterWaiter(relayDir, 101);
    expect(liveWaiterCount(relayDir, () => true)).toBe(0);
  });

  it('does not count, and removes, a waiter whose process died without cleaning up (a killed background wait)', () => {
    registerWaiter(relayDir, 101);
    registerWaiter(relayDir, 102);
    expect(liveWaiterCount(relayDir, (pid) => pid === 102)).toBe(1);
    expect(existsSync(join(relayDir, 'waiters', '101'))).toBe(false);
  });

  it('is zero when nobody ever registered, and unregistering an unknown waiter is harmless', () => {
    expect(liveWaiterCount(relayDir, () => true)).toBe(0);
    expect(() => unregisterWaiter(relayDir, 999)).not.toThrow();
  });

  it('ignores a file in waiters/ that is not a pid', () => {
    mkdirSync(join(relayDir, 'waiters'));
    writeFileSync(join(relayDir, 'waiters', 'notes.txt'), 'x');
    expect(liveWaiterCount(relayDir, () => true)).toBe(0);
  });
});

describe('on-demand marker', () => {
  it('is off by default, on once marked, off again once pinned', () => {
    expect(isOnDemand(relayDir)).toBe(false);
    markOnDemand(relayDir);
    expect(isOnDemand(relayDir)).toBe(true);
    pinRelay(relayDir);
    expect(isOnDemand(relayDir)).toBe(false);
  });

  it('pinning when nothing is marked is harmless', () => {
    expect(() => pinRelay(relayDir)).not.toThrow();
  });
});

describe('startIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const GRACE = 30_000;
  const INTERVAL = 5_000;

  function watch(options: { alive?: (pid: number) => boolean } = {}) {
    const stop = vi.fn();
    const log = vi.fn();
    const handle = startIdleWatchdog({ relayDir, graceMs: GRACE, intervalMs: INTERVAL, isAlive: options.alive ?? (() => true), stop, log });
    return { stop, log, handle };
  }

  it('never stops a relay that was started by hand (no on-demand marker), whoever waits', () => {
    const { stop, handle } = watch();
    vi.advanceTimersByTime(10 * GRACE);
    expect(stop).not.toHaveBeenCalled();
    handle.cancel();
  });

  it('stops an on-demand relay once nobody has been waiting for the grace period', () => {
    markOnDemand(relayDir);
    const { stop, log, handle } = watch();
    vi.advanceTimersByTime(GRACE - INTERVAL);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * INTERVAL);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.join('\n')).toContain('no one is waiting');
    handle.cancel();
  });

  it('keeps the relay while somebody waits', () => {
    markOnDemand(relayDir);
    registerWaiter(relayDir, 7);
    const { stop, handle } = watch();
    vi.advanceTimersByTime(10 * GRACE);
    expect(stop).not.toHaveBeenCalled();
    handle.cancel();
  });

  it('a new wait that starts inside the grace period resets it (sequential waits do not make the relay flap)', () => {
    markOnDemand(relayDir);
    const { stop, handle } = watch();
    vi.advanceTimersByTime(GRACE - INTERVAL);
    registerWaiter(relayDir, 8);
    vi.advanceTimersByTime(2 * INTERVAL);
    unregisterWaiter(relayDir, 8);
    vi.advanceTimersByTime(GRACE - INTERVAL);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * INTERVAL);
    expect(stop).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it('stops when the only waiter died without unregistering', () => {
    markOnDemand(relayDir);
    registerWaiter(relayDir, 9);
    const { stop, handle } = watch({ alive: () => false });
    vi.advanceTimersByTime(GRACE + 2 * INTERVAL);
    expect(stop).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it('stops watching once the relay was pinned by a manual start', () => {
    markOnDemand(relayDir);
    const { stop, handle } = watch();
    vi.advanceTimersByTime(GRACE / 2);
    pinRelay(relayDir);
    vi.advanceTimersByTime(10 * GRACE);
    expect(stop).not.toHaveBeenCalled();
    handle.cancel();
  });

  it('asks for the stop only once', () => {
    markOnDemand(relayDir);
    const { stop, handle } = watch();
    vi.advanceTimersByTime(10 * GRACE);
    expect(stop).toHaveBeenCalledTimes(1);
    handle.cancel();
  });
});
