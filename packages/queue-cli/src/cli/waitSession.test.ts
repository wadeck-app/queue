/**
 * The registration of a `queue wait`: it appears in the waiters list before it reads the history, stays alive with a heartbeat, and leaves with an `end` record on every
 * way out the process controls. Real registry in a temp folder; the clock, the pids, the timers, the signals and the exit are the test's (no sleep, no real signal).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WAITER_HEARTBEAT_MS, WaiterRegistry, listLiveWaiters, readWaiterHistory, waitersDir, type WaiterInput, type WaiterRegistryDeps } from '@wadeck-app/queue-core';
import { fakeWaitSession, type FakeWaitSession } from '../testing/fakeWaitSession.js';
import { anonymousWaitName, ciOutcomeOf, eventOutcomeOf, runRegisteredWait, type WaitSessionDeps } from './waitSession.js';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

let configDir: string;
let clock: { ms: number };
let alive: Set<number>;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'wait-session-'));
  clock = { ms: T0 };
  alive = new Set([100, 200]);
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function registryFor(pid: number, extra: Partial<WaiterRegistryDeps> = {}): WaiterRegistry {
  let ids = 0;
  return new WaiterRegistry(configDir, { pid, now: () => clock.ms, isAlive: (candidate) => alive.has(candidate), newId: () => `id-${pid}-${++ids}`, sleep: (ms) => { clock.ms += ms; }, onRetention: () => undefined, ...extra });
}

type Harness = FakeWaitSession;

function harness(registry: WaitSessionDeps['registry'] = registryFor(100)): Harness {
  return fakeWaitSession(registry);
}

const input: WaiterInput = { name: 'w-agent-wake.ab12cd34', events: ['onTaskDone'], whens: ['payload.taskId=abc'], label: '', since: '2026-11-08T09:50:00.000Z', cwd: '/project' };
const fileOf = (name = input.name): string => join(waitersDir(configDir), `waiter-${name}.json`);
const liveNames = (): string[] => listLiveWaiters(configDir, { now: () => clock.ms, isAlive: (pid) => alive.has(pid) }).waiters.map((waiter) => waiter.name);
const historyRows = () => readWaiterHistory(configDir, { now: () => clock.ms, isAlive: (pid) => alive.has(pid) }).rows;
const warnings = (h: Harness): string[] => h.stderr.join('').split('\n').filter((line) => line.startsWith('[warn]'));
const base = { outcomeOf: eventOutcomeOf };

describe('runRegisteredWait: registration', () => {
  it('registers before the wait runs, with every field the list shows', async () => {
    const h = harness();
    let seen: unknown;
    const code = await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      seen = listLiveWaiters(configDir, { now: () => clock.ms, isAlive: (pid) => alive.has(pid) }).waiters[0];
      return 2;
    } });
    expect(code).toBe(2);
    expect(seen).toMatchObject({ name: input.name, events: ['onTaskDone'], whens: ['payload.taskId=abc'], since: input.since, cwd: '/project', pid: 100, contact: { kind: 'none' } });
  });

  it('writes the start record before the wait runs', async () => {
    const h = harness();
    let rowsDuringRun: string[] = [];
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      rowsDuringRun = historyRows().map((row) => `${row.name}:${row.outcome}`);
      return 2;
    } });
    expect(rowsDuringRun).toEqual([`${input.name}:waiting`]);
  });

  it('sweeps the waits that are over before it registers, and goes on when the sweep fails', async () => {
    const registry = registryFor(100);
    const order: string[] = [];
    const wrapped: WaitSessionDeps['registry'] = {
      sweepStale: () => { order.push('sweep'); throw new Error('sweep failed'); },
      register: (value) => { order.push('register'); return registry.register(value); },
      heartbeat: (value) => registry.heartbeat(value),
      deregister: (value, end) => registry.deregister(value, end),
    };
    const h = harness(wrapped);
    expect(await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => 0 })).toBe(0);
    expect(order).toEqual(['sweep', 'register']);
  });

  it('says whom it took the name over from', async () => {
    registryFor(200).register(input);
    alive.delete(200);
    // The sweep would have removed the file first; the takeover is for a holder that went away between the sweep and the registration
    const registry = registryFor(100);
    const h = harness({ sweepStale: () => ({ removed: [], problems: [] }), register: (value) => registry.register(value), heartbeat: (value) => registry.heartbeat(value), deregister: (value, end) => registry.deregister(value, end) });
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => 0 });
    expect(h.stderr.join('')).toContain("[info] took over the name 'w-agent-wake.ab12cd34' from pid 200 (process gone)");
  });

  it('a name held by a live wait: exit 4 naming the holder, the wait never runs, the refusal is in the history', async () => {
    registryFor(200).register(input);
    const h = harness();
    let ran = false;
    const code = await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => { ran = true; return 0; } });
    expect(code).toBe(4);
    expect(ran).toBe(false);
    const text = h.stderr.join('');
    expect(text).toContain('[fail]');
    expect(text).toContain('each concurrent wait needs its own name');
    expect(text).toContain('pid 200');
    expect(historyRows().map((row) => row.outcome)).toContain('refused');
    expect(h.timerPeriods).toEqual([]);
    expect(h.exitHandlers).toEqual([]);
  });

  it('an input the registry refuses (too many events) is a usage error, exit 4', async () => {
    const h = harness();
    const code = await runRegisteredWait({ ...base, input: { ...input, events: Array.from({ length: 21 }, (_, i) => `on${i}`) }, deps: h.deps, run: async () => 0 });
    expect(code).toBe(4);
    expect(h.stderr.join('')).toContain('[fail]');
    expect(h.stderr.join('')).toContain('20 events at most');
  });

  it('an unwritable waiters folder: exit 1 with the path, the wait is not started unregistered', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(waitersDir(configDir), 'a file where the folder should be');
    const h = harness();
    let ran = false;
    const code = await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => { ran = true; return 0; } });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    expect(h.stderr.join('')).toContain(waitersDir(configDir));
  });
});

describe('runRegisteredWait: the end of the wait', () => {
  it('matched: the end record carries the event and its id, the file is gone', async () => {
    const h = harness();
    const code = await runRegisteredWait({ ...base, input, deps: h.deps, run: async (session) => {
      session.matched({ eventId: 'evt-1', event: 'onTaskDone' });
      return 0;
    } });
    expect(code).toBe(0);
    expect(existsSync(fileOf())).toBe(false);
    expect(historyRows()).toMatchObject([{ name: input.name, outcome: 'matched', eventId: 'evt-1', event: 'onTaskDone' }]);
  });

  it('timeout: recorded as timeout, the file is gone', async () => {
    const h = harness();
    expect(await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => 2 })).toBe(2);
    expect(existsSync(fileOf())).toBe(false);
    expect(historyRows()[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('the wait throws: cancelled, the file is gone, the error goes on', async () => {
    const h = harness();
    await expect(runRegisteredWait({ ...base, input, deps: h.deps, run: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
    expect(existsSync(fileOf())).toBe(false);
    expect(historyRows()[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('%s: recorded as cancelled, the file is gone, the process exits %i', async (signal, exit) => {
    const h = harness();
    let release: (code: number) => void = () => undefined;
    const running = runRegisteredWait({ ...base, input, deps: h.deps, run: () => new Promise<number>((resolve) => { release = resolve; }) });
    await Promise.resolve();
    h.signalHandlers.get(signal)!(signal);
    expect(h.exits).toEqual([exit]);
    expect(existsSync(fileOf())).toBe(false);
    expect(historyRows()[0]).toMatchObject({ outcome: 'cancelled' });
    release(0);
    await running;
    expect(historyRows()).toHaveLength(1);
  });

  it('the exit event (anything else that ends the process) records cancelled too', async () => {
    const h = harness();
    void runRegisteredWait({ ...base, input, deps: h.deps, run: () => new Promise<number>(() => undefined) });
    await Promise.resolve();
    h.exitHandlers[0]!();
    expect(existsSync(fileOf())).toBe(false);
    expect(historyRows()[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('stops the heartbeat and drops the signal and exit handlers on a normal end, and a late exit event writes nothing more', async () => {
    const h = harness();
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => 2 });
    expect({ stopped: h.stoppedTimers(), signals: h.disposedSignals(), exit: h.disposedExit() }).toEqual({ stopped: 1, signals: 1, exit: 1 });
    h.exitHandlers[0]!();
    expect(historyRows()).toHaveLength(1);
    expect(h.stoppedTimers()).toBe(1);
  });

  it('never deletes a file that another wait owns', async () => {
    const h = harness();
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      rmSync(fileOf());
      registryFor(200).register(input);
      return 2;
    } });
    expect(existsSync(fileOf())).toBe(true);
    expect(liveNames()).toEqual([input.name]);
  });

  it("a deregister that fails is said, with the file, and the exit code is still the wait's", async () => {
    const registry = registryFor(100);
    const failing: WaitSessionDeps['registry'] = {
      sweepStale: () => registry.sweepStale(),
      register: (value) => registry.register(value),
      heartbeat: (value) => registry.heartbeat(value),
      deregister: () => { throw new Error('EBUSY: resource busy'); },
    };
    const h = harness(failing);
    expect(await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => 0 })).toBe(0);
    const text = h.stderr.join('');
    expect(text).toContain('[warn]');
    expect(text).toContain('EBUSY');
    expect(text).toContain(fileOf());
  });
});

describe('runRegisteredWait: heartbeat', () => {
  it('ticks every WAITER_HEARTBEAT_MS and keeps the file fresh', async () => {
    const h = harness();
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      expect(h.timerPeriods).toEqual([WAITER_HEARTBEAT_MS]);
      clock.ms += 10_000;
      h.ticks[0]!();
      expect(statSync(fileOf()).mtimeMs).toBe(T0 + 10_000);
      return 2;
    } });
  });

  it('a record that was lost is written again, said once on stderr, and the wait goes on', async () => {
    const h = harness();
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      rmSync(fileOf());
      h.ticks[0]!();
      expect(existsSync(fileOf())).toBe(true);
      rmSync(fileOf());
      h.ticks[0]!();
      expect(existsSync(fileOf())).toBe(true);
      return 2;
    } });
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toContain('registered again');
  });

  it('a name taken by another live wait while this one slept: one warning, no crash', async () => {
    const h = harness();
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      rmSync(fileOf());
      registryFor(200).register(input);
      h.ticks[0]!();
      h.ticks[0]!();
      return 2;
    } });
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toContain('no longer listed');
    expect(existsSync(fileOf())).toBe(true);
  });

  it('a file that cannot be touched: one warning, the wait is not stopped', async () => {
    const failing = registryFor(100);
    const h = harness(failing);
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      // The registry's own file system seam is read-only after construction: replace the file by a directory so every touch fails
      rmSync(fileOf());
      mkdirSync(fileOf());
      h.ticks[0]!();
      h.ticks[0]!();
      h.ticks[0]!();
      rmSync(fileOf(), { recursive: true });
      return 2;
    } });
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toContain(fileOf());
  });

  it('a heartbeat that throws (it should not) is said once and never reaches the wait', async () => {
    const registry = registryFor(100);
    const h = harness({
      sweepStale: () => registry.sweepStale(),
      register: (value) => registry.register(value),
      heartbeat: () => { throw new Error('surprise'); },
      deregister: (value, end) => registry.deregister(value, end),
    });
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      h.ticks[0]!();
      h.ticks[0]!();
      return 2;
    } });
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]).toContain('surprise');
  });

  it('a heartbeat that reports a failed touch is said once, with the cause', async () => {
    const registry = registryFor(100);
    const h = harness({
      sweepStale: () => registry.sweepStale(),
      register: (value) => registry.register(value),
      heartbeat: () => ({ status: 'failed', message: 'could not refresh x: EPERM' }),
      deregister: (value, end) => registry.deregister(value, end),
    });
    await runRegisteredWait({ ...base, input, deps: h.deps, run: async () => {
      h.ticks[0]!();
      h.ticks[0]!();
      return 2;
    } });
    expect(warnings(h)).toEqual(['[warn] could not refresh x: EPERM']);
  });
});

describe('outcomeOf', () => {
  it('an event wait: 0 matched, 2 timeout, anything else cancelled', () => {
    expect([0, 2, 4, 1].map(eventOutcomeOf)).toEqual(['matched', 'timeout', 'cancelled', 'cancelled']);
  });

  it('a CI wait: passed and failed are both an answer (matched), timeout and no run are a give-up (timeout), usage is cancelled', () => {
    expect([0, 1, 2, 3, 4].map(ciOutcomeOf)).toEqual(['matched', 'matched', 'timeout', 'timeout', 'cancelled']);
  });
});

describe('anonymousWaitName', () => {
  it('is anon.<pid>, and passes a given name through', () => {
    expect(anonymousWaitName(undefined, 4242)).toBe('anon.4242');
    expect(anonymousWaitName('a.b', 4242)).toBe('a.b');
  });
});

describe('runRegisteredWait: the wake pipe', () => {
  const wakeBase = { outcomeOf: eventOutcomeOf };
  const harnessWith = (wake: Parameters<typeof fakeWaitSession>[1], registry: WaitSessionDeps['registry'] = registryFor(100)): Harness => fakeWaitSession(registry, wake);
  const contactDuringRun = (): unknown => listLiveWaiters(configDir, { now: () => clock.ms, isAlive: (pid) => alive.has(pid) }).waiters[0]?.contact;

  it('sweeps the left-over sockets, opens the pipe for the validated name BEFORE it registers, and the record carries the contact', async () => {
    const registry = registryFor(100);
    const order: string[] = [];
    let h: Harness;
    const wrapped: WaitSessionDeps['registry'] = {
      sweepStale: () => registry.sweepStale(),
      register: (value) => { order.push(h.wakeCalls.join('|')); return registry.register(value); },
      heartbeat: (value) => registry.heartbeat(value),
      deregister: (value, end) => registry.deregister(value, end),
    };
    h = harnessWith({}, wrapped);
    let seen: unknown;
    const code = await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async () => { seen = contactDuringRun(); return 0; } });
    expect(code).toBe(0);
    expect(order).toEqual([`sweep|open ${input.name}`]);
    expect(seen).toEqual({ kind: 'pipe', path: `/fake/wake-${input.name}.sock` });
  });

  it('closes the pipe when the wait ends: matched, timeout and an exception', async () => {
    for (const run of [async () => 0, async () => 2, async () => { throw new Error('boom'); }]) {
      const h = harnessWith({});
      await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run }).catch(() => undefined);
      expect(h.wakeCalls.filter((call) => call === 'close')).toHaveLength(1);
    }
  });

  it('closes the pipe on a signal and on the exit event', async () => {
    const bySignal = harnessWith({});
    await runRegisteredWait({ ...wakeBase, input, deps: bySignal.deps, run: async () => { bySignal.signalHandlers.get('SIGINT')!('SIGINT'); return 0; } });
    expect(bySignal.wakeCalls.filter((call) => call === 'close')).toHaveLength(1);
    const byExit = harnessWith({});
    await runRegisteredWait({ ...wakeBase, input, deps: byExit.deps, run: async () => { byExit.exitHandlers[0]!(); return 0; } });
    expect(byExit.wakeCalls.filter((call) => call === 'close')).toHaveLength(1);
  });

  it('closes the pipe when the registration is refused (the name is taken): no listener is left behind', async () => {
    registryFor(200).register(input);
    const h = harnessWith({});
    expect(await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async () => 0 })).toBe(4);
    expect(h.wakeCalls).toEqual(['sweep', `open ${input.name}`, 'close']);
  });

  it('never opens a pipe for a name that is not valid (no address is built from it); the registration is refused as usual', async () => {
    const h = harnessWith({});
    const code = await runRegisteredWait({ ...wakeBase, input: { ...input, name: '../evil' }, deps: h.deps, run: async () => 0 });
    expect(code).toBe(4);
    expect(h.wakeCalls.filter((call) => call.startsWith('open'))).toEqual([]);
  });

  it('a pipe that could not be opened: one [warn] line with the reason, the wait is registered as polling only and runs', async () => {
    const h = harnessWith({ warning: 'could not listen on /x (EACCES)' });
    let contact: unknown;
    const code = await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async () => { contact = contactDuringRun(); return 0; } });
    expect(code).toBe(0);
    expect(contact).toEqual({ kind: 'none' });
    const lines = warnings(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not listen on /x (EACCES)');
    expect(lines[0]).toMatch(/polls the history/);
  });

  it('a pipe that throws is a warning too, never a failed wait', async () => {
    const h = harnessWith({ throws: new Error('unexpected') });
    expect(await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async () => 0 })).toBe(0);
    expect(warnings(h).join('\n')).toContain('unexpected');
  });

  it('a sweep of left-over sockets that fails is said and the wait goes on', async () => {
    const h = harnessWith({ sweepThrows: new Error('EPERM') });
    expect(await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async () => 0 })).toBe(0);
    expect(warnings(h).join('\n')).toContain('EPERM');
    expect(h.wakeCalls).toContain(`open ${input.name}`);
  });

  it('a wake from the pipe ends the sleep of the wait at once', async () => {
    const h = harnessWith({});
    const code = await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async (session) => {
      const slept = session.sleep(500, () => new Promise<void>(() => undefined));
      h.wakeHandlers[0]!({ event: 'onTaskDone', eventId: 'e1' });
      await slept;
      return 0;
    } });
    expect(code).toBe(0);
  });

  it('without a wake pipe (older callers) the sleep is the plain one', async () => {
    const h = harness();
    let slept = 0;
    await runRegisteredWait({ ...wakeBase, input, deps: h.deps, run: async (session) => { await session.sleep(500, async () => { slept++; }); return 0; } });
    expect(slept).toBe(1);
  });
});
