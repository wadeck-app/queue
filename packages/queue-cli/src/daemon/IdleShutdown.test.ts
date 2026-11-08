import { describe, it, expect } from 'vitest';
import { IdleShutdown, type IdleTimers } from './IdleShutdown.js';

/** Timers driven by hand: nothing here waits for real time. */
class FakeClock implements IdleTimers {
  time = 0;
  private nextId = 1;
  private readonly timeouts = new Map<number, { at: number; run: () => void }>();
  private readonly intervals = new Map<number, { every: number; next: number; run: () => void }>();

  now = (): number => this.time;
  setTimeout = (run: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timeouts.set(id, { at: this.time + ms, run });
    return id;
  };
  clearTimeout = (id: unknown): void => { this.timeouts.delete(id as number); };
  setInterval = (run: () => void, ms: number): number => {
    const id = this.nextId++;
    this.intervals.set(id, { every: ms, next: this.time + ms, run });
    return id;
  };
  clearInterval = (id: unknown): void => { this.intervals.delete(id as number); };

  get pendingTimeouts(): number { return this.timeouts.size; }

  /** Moves time forward, firing what is due in time order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [
        ...[...this.timeouts.entries()].map(([id, t]) => ({ at: t.at, kind: 'timeout' as const, id })),
        ...[...this.intervals.entries()].map(([id, i]) => ({ at: i.next, kind: 'interval' as const, id })),
      ].filter((d) => d.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      this.time = due.at;
      if (due.kind === 'timeout') {
        const t = this.timeouts.get(due.id)!;
        this.timeouts.delete(due.id);
        t.run();
      } else {
        const i = this.intervals.get(due.id)!;
        i.next += i.every;
        i.run();
      }
    }
    this.time = target;
  }
}

function setup(): { clock: FakeClock; idle: { value: boolean }; stops: string[]; errors: unknown[]; shutdown: IdleShutdown } {
  const clock = new FakeClock();
  const idle = { value: true };
  const stops: string[] = [];
  const errors: unknown[] = [];
  const shutdown = new IdleShutdown({
    isIdle: () => idle.value,
    stop: () => { stops.push('idle'); },
    onStopError: (err) => { errors.push(err); },
    timeoutMs: 60_000,
    checkIntervalMs: 10_000,
    timers: clock,
  });
  shutdown.start();
  return { clock, idle, stops, errors, shutdown };
}

describe('IdleShutdown', () => {
  it('stops the daemon once it has been idle for the whole timeout', () => {
    const { clock, stops } = setup();
    clock.advance(59_000);
    expect(stops).toEqual([]);
    clock.advance(20_000);
    expect(stops).toEqual(['idle']);
  });

  it('never stops while the service is busy, and does not count the busy time as idle time', () => {
    const { clock, idle, stops } = setup();
    idle.value = false;
    clock.advance(300_000);
    expect(stops).toEqual([]);
    idle.value = true;
    clock.advance(40_000);
    expect(stops).toEqual([]);
    clock.advance(40_000);
    expect(stops).toEqual(['idle']);
  });

  it('re-checks at fire time: work that arrived after the countdown started cancels the stop', () => {
    const { clock, idle, stops } = setup();
    // idle is seen at the first check (10 s), the countdown ends at 70 s; at 69 s something starts and nobody told the countdown
    clock.advance(69_000);
    idle.value = false;
    clock.advance(2_000);
    expect(stops).toEqual([]);
  });

  it('counts a command as activity: the countdown restarts from the end of the command, whatever the command', async () => {
    const { clock, stops, shutdown } = setup();
    const wrapped = shutdown.wrap({ retry: () => 'ok' });
    clock.advance(50_000);
    await wrapped.retry();
    // 50 s after the start but only 10 s after the command: not due yet
    clock.advance(20_000);
    expect(stops).toEqual([]);
    clock.advance(50_000);
    expect(stops).toEqual(['idle']);
  });

  it('fire-time activity check: activity noted just before the countdown fires cancels that stop (the countdown itself was not cleared)', () => {
    const { clock, stops, shutdown } = setup();
    // the countdown started at 10 s fires at 70 s
    clock.advance(69_500);
    shutdown.noteActivity();
    clock.advance(1_000);
    expect(stops).toEqual([]);
    // and it is idle for a whole timeout after that activity
    clock.advance(80_000);
    expect(stops).toEqual(['idle']);
  });

  it('never stops while a command is running, however long it takes', async () => {
    const { clock, stops, shutdown } = setup();
    let release: () => void = () => undefined;
    const wrapped = shutdown.wrap({ 'register-events': () => new Promise<void>((resolve) => { release = resolve; }) });
    const running = wrapped['register-events']();
    clock.advance(600_000);
    expect(stops).toEqual([]);
    release();
    await running;
    clock.advance(80_000);
    expect(stops).toEqual(['idle']);
  });

  it('a command that throws still ends its activity, and the error reaches the caller', async () => {
    const { clock, stops, shutdown } = setup();
    const wrapped = shutdown.wrap({ 'give-up': () => { throw new Error('boom'); } });
    await expect((async () => wrapped['give-up']())()).rejects.toThrow('boom');
    clock.advance(80_000);
    expect(stops).toEqual(['idle']);
  });

  it('keeps the arguments and the result of the wrapped command', async () => {
    const { shutdown } = setup();
    const wrapped = shutdown.wrap({ echo: (payload: unknown) => ({ got: payload }) });
    expect(await wrapped.echo({ a: 1 })).toEqual({ got: { a: 1 } });
  });

  it('reports a stop that fails instead of dropping it', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const shutdown = new IdleShutdown({ isIdle: () => true, stop: () => Promise.reject(new Error('cannot stop')), onStopError: (err) => errors.push(err), timeoutMs: 60_000, checkIntervalMs: 10_000, timers: clock });
    shutdown.start();
    clock.advance(80_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    // the daemon is still running: it looks again, and tries to stop again
    clock.advance(80_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(2);
  });

  it('dispose cancels the interval and the countdown: nothing stops afterwards', () => {
    const { clock, stops, shutdown } = setup();
    clock.advance(20_000);
    shutdown.dispose();
    clock.advance(600_000);
    expect(stops).toEqual([]);
    expect(clock.pendingTimeouts).toBe(0);
  });

  it('stops once only, however many ticks follow', () => {
    const { clock, stops } = setup();
    clock.advance(600_000);
    expect(stops).toEqual(['idle']);
  });
});
