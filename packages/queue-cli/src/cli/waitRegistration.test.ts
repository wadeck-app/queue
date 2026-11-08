/**
 * `queue wait` and `queue wait ci` register themselves: the wiring in waitCli.ts, in this process, with the real registry of a throwaway config dir, a history reader the test
 * controls, a fake clock and a fake outside world (timers, signals, exit). Nothing sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WaiterRegistry, listLiveWaiters, readWaiterHistory, waitersDir, type HistoryEntry } from '@wadeck-app/queue-core';
import { queueWaitCommand, registeredWhens, type QueueWaitDeps } from './waitCli.js';
import { fakeWaitSession, type FakeWaitSession, type FakeWakeOptions } from '../testing/fakeWaitSession.js';
import type { GitPort } from './ciGit.js';

let configDir: string;
let stderr: string;
let clock: { ms: number };

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-wait-registration-'));
  stderr = '';
  clock = { ms: Date.now() };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const relayCannotStart = async (): Promise<number> => 1;

function entry(event: string, atMs: number, payload: unknown = {}): HistoryEntry {
  return { ts: new Date(atMs).toISOString(), eventId: `evt-${event}-${atMs}`, event, subscribers: [], orphan: false, payload };
}

interface Run {
  session: FakeWaitSession;
  /** What happened, in order: 'register', 'timer', 'read'. */
  order: string[];
  code: Promise<number>;
}

/** Runs `queue wait ...args` in this process. `entries` is what the history holds (the wait reads it with the event it asks for). */
function runWait(args: string[], entries: () => HistoryEntry[] = () => [], extra: QueueWaitDeps = {}, wake?: FakeWakeOptions): Run {
  const order: string[] = [];
  const registry = new WaiterRegistry(configDir);
  const session = fakeWaitSession(
    {
    sweepStale: () => registry.sweepStale(),
    register: (input) => { order.push('register'); return registry.register(input); },
    heartbeat: (registration) => registry.heartbeat(registration),
    deregister: (registration, end) => registry.deregister(registration, end),
    },
    wake,
  );
  const startTimer = session.deps.startTimer;
  session.deps.startTimer = (tick, ms) => { order.push('timer'); return startTimer(tick, ms); };
  const code = queueWaitCommand(configDir, args, relayCannotStart, {
    session: session.deps,
    historyReader: { read: ({ event, sinceMs }) => { order.push('read'); return entries().filter((e) => (event === undefined || e.event === event) && Date.parse(e.ts) >= sinceMs); } },
    now: () => clock.ms,
    sleep: async (ms) => { clock.ms += ms; },
    pid: 4242,
    ...extra,
  });
  return { session, order, code };
}

const live = () => listLiveWaiters(configDir).waiters;
const rows = () => readWaiterHistory(configDir).rows;

describe('queue wait <event> --name', () => {
  it('registers, starts the heartbeat, and only then reads the history', async () => {
    const { order, code } = runWait(['onTaskDone', '--name', 'w-agent-wake.ab12cd34', '--timeout', '1s']);
    expect(await code).toBe(2);
    expect(order.slice(0, 3)).toEqual(['register', 'timer', 'read']);
  });

  it('the record shows the name, the events, the filters, the effective --since and the cwd', async () => {
    let record: unknown;
    const startedAt = clock.ms;
    const { code } = runWait(['onTaskDone', '--when', 'payload.taskId=abc', '--name', 'w-agent-wake.ab12cd34', '--since', '10m', '--timeout', '1s'], () => {
      record = live()[0];
      return [];
    });
    await code;
    expect(record).toMatchObject({
      name: 'w-agent-wake.ab12cd34',
      events: ['onTaskDone'],
      whens: ['payload.taskId=abc'],
      label: '',
      cwd: process.cwd(),
      pid: process.pid,
    });
    expect(Date.parse((record as { since: string }).since)).toBe(startedAt - 10 * 60_000);
  });

  it('matched: the history says matched with the event and its id, and the file is gone', async () => {
    const found = entry('onTaskDone', clock.ms - 1000);
    const { code } = runWait(['onTaskDone', '--name', 'w-agent-wake.ab12cd34', '--since', '10m'], () => [found]);
    expect(await code).toBe(0);
    expect(live()).toEqual([]);
    expect(rows()).toMatchObject([{ name: 'w-agent-wake.ab12cd34', outcome: 'matched', event: 'onTaskDone', eventId: found.eventId }]);
  });

  it('an event recorded before the wait started is still found with --since while the wait is registered', async () => {
    const earlier = entry('onTaskDone', clock.ms - 5 * 60_000);
    let registeredWhenRead = false;
    const { code } = runWait(['onTaskDone', '--name', 'a.b', '--since', '10m'], () => {
      registeredWhenRead = live().length === 1;
      return [earlier];
    });
    expect(await code).toBe(0);
    expect(registeredWhenRead).toBe(true);
  });

  it('timeout: recorded as timeout', async () => {
    const { code } = runWait(['onTaskDone', '--name', 'a.b', '--timeout', '2s']);
    expect(await code).toBe(2);
    expect(rows()).toMatchObject([{ name: 'a.b', outcome: 'timeout' }]);
    expect(existsSync(join(waitersDir(configDir), 'waiter-a.b.json'))).toBe(false);
  });

  it('a name held by a live wait exits 4 and says each concurrent wait needs its own name', async () => {
    new WaiterRegistry(configDir).register({ name: 'a.b', events: ['onOther'], whens: [], label: '', since: new Date().toISOString(), cwd: '/x' });
    const { code, order, session } = runWait(['onTaskDone', '--name', 'a.b']);
    expect(await code).toBe(4);
    expect(session.stderr.join('')).toContain('each concurrent wait needs its own name');
    expect(session.stderr.join('')).toContain(`pid ${process.pid}`);
    expect(order).toEqual(['register']);
    expect(rows().map((row) => row.outcome).sort()).toEqual(['refused', 'waiting']);
  });

  it('a usage error registers nothing', async () => {
    const { code, order } = runWait(['onTaskDone', '--name', 'nodot']);
    expect(await code).toBe(4);
    expect(stderr).toContain('must look like <who>.<what>');
    expect(order).toEqual([]);
    expect(existsSync(waitersDir(configDir))).toBe(false);
  });

  it('several events with the same filters register them once; with different filters they register none', async () => {
    const same = runWait(['onA', '--when', 'payload.x=1', 'onB', '--when', 'payload.x=1', '--name', 'a.same', '--timeout', '1s'], () => {
      expect(live()[0]).toMatchObject({ events: ['onA', 'onB'], whens: ['payload.x=1'] });
      return [];
    });
    await same.code;
    const different = runWait(['onA', '--when', 'payload.x=1', 'onB', '--name', 'a.different', '--timeout', '1s'], () => {
      expect(live().find((waiter) => waiter.name === 'a.different')).toMatchObject({ events: ['onA', 'onB'], whens: [] });
      return [];
    });
    await different.code;
    expect(rows().map((row) => row.outcome)).toEqual(['timeout', 'timeout']);
  });

  it('the same event twice is registered once', async () => {
    const { code } = runWait(['onA', 'onA', '--name', 'a.twice', '--timeout', '1s'], () => {
      expect(live()[0]!.events).toEqual(['onA']);
      return [];
    });
    await code;
  });
});

describe('queue wait <event> without --name (release A)', () => {
  it('registers as anon.<pid> and warns once, with an example of a name', async () => {
    const { code } = runWait(['onTaskDone', '--timeout', '1s'], () => {
      expect(live()[0]!.name).toBe('anon.4242');
      return [];
    });
    expect(await code).toBe(2);
    const warnings = stderr.split('\n').filter((line) => line.startsWith('[warn] no --name'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('registered as anon.4242');
    expect(warnings[0]).toContain('will become mandatory');
    expect(warnings[0]).toContain('--name w-agent-wake.ab12cd34');
  });

  it('a named wait does not warn', async () => {
    await runWait(['onTaskDone', '--name', 'a.b', '--timeout', '1s']).code;
    expect(stderr).not.toContain('no --name');
  });
});

describe('queue wait --name: the wake is a hint, the history decides', () => {
  const NEVER = (): Promise<void> => new Promise<void>(() => undefined);

  it('a wake ends the sleep and the wait reads the history again at once: it finishes without a poll tick ever ending a sleep', async () => {
    let history: HistoryEntry[] = [];
    let fireWake: () => void = () => undefined;
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--timeout', '30m'], () => history, {
      // The poll sleep never ends; the only way out of it is the wake, fired by the "daemon" once the event is in the history
      sleep: () => {
        history = [entry('onTaskDone', clock.ms + 1)];
        fireWake();
        return NEVER();
      },
    }, {});
    fireWake = () => { run.session.wakeHandlers[0]!({ event: 'onTaskDone', eventId: 'evt' }); };
    expect(await run.code).toBe(0);
    expect(run.session.wakeCalls).toEqual(['sweep', 'open a.wake', 'close']);
    expect(rows()[0]).toMatchObject({ name: 'a.wake', outcome: 'matched' });
  });

  it('the contact in the record is the pipe the wait listens on', async () => {
    let contact: unknown;
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--timeout', '1s'], () => { contact = live()[0]?.contact; return []; }, {}, {});
    await run.code;
    expect(contact).toEqual({ kind: 'pipe', path: '/fake/wake-a.wake.sock' });
  });

  it('a wake for something the history does not hold changes nothing: the wait reads, finds nothing and sleeps again until its timeout', async () => {
    let reads = 0;
    let sleeps = 0;
    let fireWake: () => void = () => undefined;
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--timeout', '10s'], () => { reads++; return []; }, {
      sleep: async (ms) => {
        sleeps++;
        if (sleeps === 1) {
          // A forged or early wake, first: nothing is in the history
          fireWake();
          return NEVER();
        }
        clock.ms += ms + 20_000;
      },
    }, {});
    fireWake = () => { run.session.wakeHandlers[0]!({ event: 'onTaskDone', eventId: 'forged' }); };
    expect(await run.code).toBe(2);
    // first read, the read after the wake, the read after the timeout poll
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(rows()[0]).toMatchObject({ outcome: 'timeout' });
  });

  it('a lost wake costs one poll: the event is found when the poll sleep ends, with no wake ever fired', async () => {
    let history: HistoryEntry[] = [];
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--timeout', '30m'], () => history, {
      sleep: async (ms) => { clock.ms += ms; history = [entry('onTaskDone', clock.ms)]; },
    }, {});
    expect(await run.code).toBe(0);
  });

  it('a wait whose pipe could not be opened still finds the event by polling', async () => {
    let history: HistoryEntry[] = [];
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--timeout', '30m'], () => history, {
      sleep: async (ms) => { clock.ms += ms; history = [entry('onTaskDone', clock.ms)]; },
    }, { warning: 'could not listen' });
    expect(await run.code).toBe(0);
    expect(run.session.stderr.join('')).toContain('not woken by');
  });

  it('--since still finds an event recorded before the wait started, with a pipe open', async () => {
    const run = runWait(['onTaskDone', '--name', 'a.wake', '--since', '10m', '--timeout', '30m'], () => [entry('onTaskDone', clock.ms - 60_000)], {}, {});
    expect(await run.code).toBe(0);
  });
});

describe('queue wait ci --name: the wake', () => {
  const SHA = 'b'.repeat(40);
  const git: GitPort = { read: (args) => (args.join(' ') === 'remote get-url origin' ? 'git@github.com:o/r.git' : null), succeeds: () => true };

  it('registers with the pipe it listens on and closes it on the way out', async () => {
    let contact: unknown;
    const run = runWait(['ci', SHA, '--no-infer', '--repo', 'o/r', '--name', 'a.ciwake'], () => { contact = live()[0]?.contact; return []; }, { git }, {});
    await run.code;
    expect(contact).toEqual({ kind: 'pipe', path: '/fake/wake-a.ciwake.sock' });
    expect(run.session.wakeCalls).toEqual(['sweep', 'open a.ciwake', 'close']);
  });
});

describe('queue wait ci --name', () => {
  const SHA = 'a'.repeat(40);
  const git: GitPort = { read: (args) => (args.join(' ') === 'remote get-url origin' ? 'git@github.com:o/r.git' : null), succeeds: () => true };

  it('registers the workflow-run event with the sha as label, before the relay is looked at, and records the give-up', async () => {
    let record: unknown;
    const { code } = runWait(['ci', SHA, '--no-infer', '--repo', 'o/r', '--name', 'w-agent-wake.ci-aaaaaaaa'], () => {
      record = live()[0];
      return [];
    }, { git });
    // No run in the history and a relay that cannot start: exit 3
    expect(await code).toBe(3);
    expect(record).toMatchObject({ name: 'w-agent-wake.ci-aaaaaaaa', events: ['on.github.workflow_run'], whens: [], label: SHA });
    expect(rows()).toMatchObject([{ name: 'w-agent-wake.ci-aaaaaaaa', outcome: 'timeout' }]);
  });

  it('without --name: anon.<pid> and one warning that shows the ci form', async () => {
    await runWait(['ci', SHA, '--no-infer', '--repo', 'o/r'], () => [], { git }).code;
    expect(stderr).toContain('registered as anon.4242');
    expect(stderr).toContain('queue wait ci --name');
  });

  it('a name held by a live wait exits 4', async () => {
    new WaiterRegistry(configDir).register({ name: 'a.b', events: ['onOther'], whens: [], label: '', since: new Date().toISOString(), cwd: '/x' });
    const { code, session } = runWait(['ci', SHA, '--no-infer', '--repo', 'o/r', '--name', 'a.b'], () => [], { git });
    expect(await code).toBe(4);
    expect(session.stderr.join('')).toContain('each concurrent wait needs its own name');
  });

  it('a bad --name registers nothing', async () => {
    const { code, order } = runWait(['ci', SHA, '--no-infer', '--name', 'Bad'], () => [], { git });
    expect(await code).toBe(4);
    expect(order).toEqual([]);
  });
});

describe('registeredWhens', () => {
  const target = (...whens: string[]) => ({ event: 'x', whens });
  it.each([
    [[target()], []],
    [[target('a=1', 'b=2')], ['a=1', 'b=2']],
    [[target('a=1'), target('a=1')], ['a=1']],
    [[target('a=1'), target('a=2')], []],
    [[target('a=1'), target()], []],
    [[target('a=1', 'b=2'), target('b=2', 'a=1')], []],
  ])('%j -> %j', (targets, expected) => {
    expect(registeredWhens(targets)).toEqual(expected);
  });
});
