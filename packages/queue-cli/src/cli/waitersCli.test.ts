/**
 * `queue waiters` and `queue waiters --history`, in this process: real registry and history files of a throwaway config dir, the clock and the pids that are alive are the
 * test's. Output is read from the injected streams.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WAITER_TTL_MS, WaiterRegistry, waitersDir, type WaiterInput } from '@wadeck-app/queue-core';
import { waitersCommand, type WaitersDeps } from './waitersCli.js';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

let configDir: string;
let clock: { ms: number };
let alive: Set<number>;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-waiters-'));
  clock = { ms: T0 };
  alive = new Set([100, 200, 300]);
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function registryFor(pid: number): WaiterRegistry {
  let ids = 0;
  return new WaiterRegistry(configDir, { pid, now: () => clock.ms, isAlive: (candidate) => alive.has(candidate), newId: () => `id-${pid}-${++ids}`, sleep: (ms) => { clock.ms += ms; }, onRetention: () => undefined, onDiagnostic: () => undefined });
}

const input = (name: string, extra: Partial<WaiterInput> = {}): WaiterInput => ({ name, events: ['onTaskDone'], whens: [], label: '', since: new Date(T0).toISOString(), cwd: '/project', ...extra });

interface Out { code: number; stdout: string; stderr: string }

async function run(args: string[], extra: Partial<WaitersDeps> = {}): Promise<Out> {
  let stdout = '';
  let stderr = '';
  const code = await waitersCommand(args, {
    configDir,
    io: { stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } },
    now: () => clock.ms,
    isAlive: (pid) => alive.has(pid),
    ...extra,
  });
  return { code, stdout, stderr };
}

describe('queue waiters', () => {
  it('says so when nobody waits, and --json is an empty array', async () => {
    expect(await run([])).toMatchObject({ code: 0, stdout: '[ok] no one is waiting\n' });
    expect(JSON.parse((await run(['--json'])).stdout)).toEqual([]);
  });

  it('lists a live wait with its name, events, filters, label, contact, since and last seen', async () => {
    registryFor(100).register(input('w-agent-wake.ab12cd34', { events: ['onA', 'onB'], whens: ['payload.x=1'], label: 'task abc' }));
    clock.ms += 5000;
    const out = await run([]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Waiting now (1):');
    expect(out.stdout).toContain('w-agent-wake.ab12cd34');
    expect(out.stdout).toContain('onA, onB where payload.x=1');
    expect(out.stdout).toContain('task abc');
    expect(out.stdout).toContain('polling only');
    expect(out.stdout).toContain('5s ago');
    expect(out.stdout).not.toContain('(stale)');
  });

  it('shows the contact: "pipe" for a wait the daemon wakes, "polling only" for one it cannot', async () => {
    registryFor(100).register(input('a.piped', { contact: { kind: 'pipe', path: '/c/waiters/wake-0123456789abcdef.sock' } }));
    registryFor(200).register(input('b.polled'));
    const out = await run([]);
    const piped = out.stdout.split('\n').find((line) => line.includes('a.piped'))!;
    const polled = out.stdout.split('\n').find((line) => line.includes('b.polled'))!;
    expect(piped).toMatch(/\bpipe\b/);
    expect(piped).not.toContain('polling only');
    expect(polled).toContain('polling only');
    const json = JSON.parse((await run(['--json'])).stdout) as Array<{ name: string; contact: string }>;
    expect(json.map((row) => [row.name, row.contact]).sort()).toEqual([['a.piped', 'pipe'], ['b.polled', 'none']]);
    // The path is not repeated in the list: it is derived from the name
    expect(out.stdout).not.toContain('wake-0123456789abcdef');
  });

  it('--json is an array of waiters with every field, a numeric-free last seen as ISO, and the stale and anonymous flags', async () => {
    registryFor(100).register(input('a.b', { whens: ['payload.x=1'], label: 'L' }));
    const parsed = JSON.parse((await run(['--json'])).stdout) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([
      {
        id: 'id-100-1',
        name: 'a.b',
        anonymous: false,
        events: ['onTaskDone'],
        whens: ['payload.x=1'],
        label: 'L',
        contact: 'none',
        pid: 100,
        cwd: '/project',
        since: new Date(T0).toISOString(),
        startedAt: new Date(T0).toISOString(),
        lastSeen: new Date(T0).toISOString(),
        stale: false,
      },
    ]);
  });

  it('marks a wait that has no name of its own (anon.*)', async () => {
    registryFor(100).register(input('anon.100'));
    expect((await run([])).stdout).toContain('anon.100 (no --name)');
    expect((JSON.parse((await run(['--json'])).stdout) as Array<{ anonymous: boolean }>)[0]!.anonymous).toBe(true);
  });

  it('flags a wait whose heartbeat is late (more than two heartbeats) but not yet expired', async () => {
    registryFor(100).register(input('a.b'));
    clock.ms += 40_000;
    expect((JSON.parse((await run(['--json'])).stdout) as Array<{ stale: boolean }>)[0]!.stale).toBe(true);
    expect((await run([])).stdout).toContain('(stale)');
  });

  it('a wait whose process is gone is not listed; it is recorded as lost (once) and said', async () => {
    registryFor(100).register(input('a.b'));
    alive.delete(100);
    const out = await run([]);
    expect(out.stdout).toBe('[ok] no one is waiting\n');
    expect(out.stderr).toContain('[info] 1 wait that ended without a trace was recorded as lost: a.b');
    expect((await run([])).stderr).toBe('');
    const history = JSON.parse((await run(['--history', '--json'])).stdout) as Array<{ outcome: string }>;
    expect(history.map((row) => row.outcome)).toEqual(['lost']);
  });

  it('a record nobody can read is said on stderr with its path, and does not stop the list', async () => {
    registryFor(100).register(input('a.b'));
    const bad = join(waitersDir(configDir), 'waiter-bad.name.json');
    writeFileSync(bad, '{not json');
    utimesSync(bad, new Date(clock.ms), new Date(clock.ms));
    const out = await run([]);
    expect(out.stdout).toContain('a.b');
    expect(out.stderr).toContain('[warn]');
    expect(out.stderr).toContain('waiter-bad.name.json');
  });

  it('no control character of a name, a filter or a label reaches the terminal', async () => {
    registryFor(100).register(input('a.b', { whens: ['payload.x=\u001b[31mred'], label: 'l\u0007abel' }));
    const out = await run([]);
    expect(out.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(out.stdout).toContain('label');
  });

  it('refuses the history options without --history, saying what to do', async () => {
    for (const flag of ['--since', '--name', '--outcome', '--limit']) {
      const out = await run([flag, '1']);
      expect(out.code, flag).toBe(1);
      expect(out.stderr, flag).toContain(`${flag} only applies to the history`);
      expect(out.stderr, flag).toContain('queue waiters --history');
    }
  });
});

describe('queue waiters --history', () => {
  function recordWaits(): void {
    const first = registryFor(100);
    const a = first.register(input('agent.one', { label: 'first' }));
    clock.ms += 60_000;
    first.deregister(a, { outcome: 'matched', eventId: 'evt-1', event: 'onTaskDone' });
    clock.ms += 1000;
    const b = registryFor(200).register(input('agent.two'));
    clock.ms += 120_000;
    registryFor(200).deregister(b, { outcome: 'timeout' });
    clock.ms += 1000;
    registryFor(300).register(input('other.three'));
  }

  it('says so when nothing was recorded', async () => {
    expect((await run(['--history'])).stdout).toBe('[ok] no wait recorded\n');
    expect(JSON.parse((await run(['--history', '--json'])).stdout)).toEqual([]);
  });

  it('lists the waits newest first with from, to, duration, outcome and the event they matched', async () => {
    recordWaits();
    const out = await run(['--history']);
    expect(out.code).toBe(0);
    const lines = out.stdout.split('\n');
    const order = ['other.three', 'agent.two', 'agent.one'].map((name) => lines.findIndex((line) => line.includes(name)));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    const one = lines.find((line) => line.includes('agent.one'))!;
    expect(one).toContain('2026-11-08T10:00:00Z');
    expect(one).toContain('2026-11-08T10:01:00Z');
    expect(one).toContain('1m 0s');
    expect(one).toContain('matched');
    expect(one).toContain('onTaskDone (evt-1)');
    expect(lines.find((line) => line.includes('agent.two'))).toContain('timeout');
    expect(lines.find((line) => line.includes('other.three'))).toContain('waiting');
  });

  it('--json is the rows of the reader, newest first', async () => {
    recordWaits();
    const rows = JSON.parse((await run(['--history', '--json'])).stdout) as Array<{ name: string; outcome: string; eventId?: string; durationMs?: number }>;
    expect(rows.map((row) => `${row.name}:${row.outcome}`)).toEqual(['other.three:waiting', 'agent.two:timeout', 'agent.one:matched']);
    expect(rows[2]).toMatchObject({ eventId: 'evt-1', durationMs: 60_000 });
  });

  it('--name takes a glob, --outcome one outcome, --limit the newest N', async () => {
    recordWaits();
    const names = async (args: string[]) => (JSON.parse((await run(['--history', '--json', ...args])).stdout) as Array<{ name: string }>).map((row) => row.name);
    expect(await names(['--name', 'agent.*'])).toEqual(['agent.two', 'agent.one']);
    expect(await names(['--outcome', 'matched'])).toEqual(['agent.one']);
    expect(await names(['--outcome', 'waiting'])).toEqual(['other.three']);
    expect(await names(['--limit', '1'])).toEqual(['other.three']);
  });

  it('--since keeps the waits that ended in the window and the ones still waiting', async () => {
    recordWaits();
    const names = async (since: string) => (JSON.parse((await run(['--history', '--json', '--since', since])).stdout) as Array<{ name: string }>).map((row) => row.name);
    // The clock is at T0 + 183 s: agent.one ended 122 s ago, agent.two 1 s ago
    expect(await names('30s')).toEqual(['other.three', 'agent.two']);
    expect(await names('1h')).toEqual(['other.three', 'agent.two', 'agent.one']);
  });

  it('a wait that was killed shows as lost', async () => {
    registryFor(100).register(input('a.b'));
    alive.delete(100);
    clock.ms += WAITER_TTL_MS + 1000;
    const rows = JSON.parse((await run(['--history', '--json'])).stdout) as Array<{ outcome: string }>;
    expect(rows.map((row) => row.outcome)).toEqual(['lost']);
  });

  it.each([
    [['--outcome', 'bogus'], '--outcome must be one of waiting, matched, timeout, cancelled, refused, lost'],
    [['--limit', '0'], '--limit must be a whole number from 1'],
    [['--limit', 'many'], '--limit must be a whole number from 1'],
    [['--since', 'yesterday'], '--since "yesterday" is not a duration (30m, 2h, 7d)'],
  ])('refuses %j with the rule', async (args, message) => {
    const out = await run(['--history', ...args]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('[fail]');
    expect(out.stderr).toContain(message);
  });
});
