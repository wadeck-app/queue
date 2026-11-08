import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeSignal } from './wakeSignal.js';

afterEach(() => {
  vi.useRealTimers();
});

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('WakeSignal: a sleep that a wake ends early', () => {
  it('a wake ends a sleep that would otherwise never end (no clock involved)', async () => {
    const signal = new WakeSignal();
    const slept = signal.sleep(500, never);
    signal.wake();
    await slept;
  });

  it('without a wake the sleep is the base sleep', async () => {
    const signal = new WakeSignal();
    const calls: number[] = [];
    await signal.sleep(500, async (ms) => { calls.push(ms); });
    expect(calls).toEqual([500]);
  });

  it('a wake that arrives while the wait is reading (not sleeping) is not lost: the next sleep returns at once, without sleeping', async () => {
    const signal = new WakeSignal();
    signal.wake();
    let slept = 0;
    await signal.sleep(500, async () => { slept++; });
    expect(slept).toBe(0);
    // ...but only once
    await signal.sleep(500, async () => { slept++; });
    expect(slept).toBe(1);
  });

  it('a flood of wakes is one extra read, not one per wake', async () => {
    const signal = new WakeSignal();
    for (let i = 0; i < 1000; i++) signal.wake();
    let slept = 0;
    await signal.sleep(500, async () => { slept++; });
    await signal.sleep(500, async () => { slept++; });
    expect(slept).toBe(1);
  });

  it('with no base sleep it uses its own timer, and a wake cancels that timer (nothing is left to keep the process alive)', async () => {
    vi.useFakeTimers();
    const signal = new WakeSignal();
    const slept = signal.sleep(500);
    expect(vi.getTimerCount()).toBe(1);
    signal.wake();
    await slept;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with no base sleep the timer ends the sleep when nothing wakes it', async () => {
    vi.useFakeTimers();
    const signal = new WakeSignal();
    const slept = signal.sleep(500);
    await vi.advanceTimersByTimeAsync(500);
    await slept;
    expect(vi.getTimerCount()).toBe(0);
  });
});
