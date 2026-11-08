/**
 * `queue wait --name`, `queue waiters` and the waiters count of `queue push`, end to end: the real bundle, real processes, an isolated environment (own config dir,
 * home, free ports, fake orch). A wait runs in the background; nothing sleeps: each step waits for the condition it needs (a wait listed, a process ended) with a hang guard
 * of minutes, never as an assertion on time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { runQueueCliAsync } from '../testing/runCli.js';
import { testBundleFile } from '../testing/testBundle.js';
import { spawnOwned, waitFor, withHangGuard, type OwnedProcess } from '../testWaitFor.js';

let iso: IsolatedCliEnv;
const started: OwnedProcess[] = [];

beforeAll(() => {
  iso = createIsolatedCliEnv();
});

afterAll(() => {
  for (const wait of started) {
    wait.child.kill();
  }
  // Best effort: the daemon a push started must not outlive the run
  spawnSync(process.execPath, [testBundleFile('queue.cjs'), 'stop'], { encoding: 'utf-8', timeout: 60_000, env: iso.env });
  iso.cleanup();
});

const queue = (args: string[]) => runQueueCliAsync(iso.env, args);

/** `queue wait ...args` in the background. */
function startWait(args: string[]): OwnedProcess {
  const wait = spawnOwned(process.execPath, [testBundleFile('queue.cjs'), 'wait', ...args], { env: iso.env });
  started.push(wait);
  return wait;
}

interface ListedWait { name: string; pid: number; events: string[]; anonymous: boolean; contact: string }
interface HistoryRow { name: string; outcome: string; eventId?: string; event?: string; endedAt?: string }

async function liveNames(): Promise<string[]> {
  const result = await queue(['waiters', '--json']);
  expect(result.exitCode, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as ListedWait[]).map((wait) => wait.name);
}

async function waitUntilListed(name: string, wait: OwnedProcess): Promise<void> {
  await waitFor(async () => {
    if (wait.child.exitCode !== null) {
      throw new Error(`the wait ${name} ended before it was listed (exit ${wait.child.exitCode}):\n${wait.stdout()}\n${wait.stderr()}`);
    }
    return (await liveNames()).includes(name);
  }, `the wait ${name} to be listed by "queue waiters"`);
}

async function historyOf(name: string): Promise<HistoryRow[]> {
  const result = await queue(['waiters', '--history', '--json', '--name', name]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as HistoryRow[];
}

describe('queue wait --name, queue waiters, queue push (bundled CLI)', () => {
  it('a named wait is listed, counted by the push, ends with the event, and a second wait with its name is refused', async () => {
    const wait = startWait(['onI2.matched', '--name', 'i2.matched', '--timeout', '10m']);
    await waitUntilListed('i2.matched', wait);

    const listed = await queue(['waiters', '--json']);
    const entry = (JSON.parse(listed.stdout) as ListedWait[]).find((candidate) => candidate.name === 'i2.matched')!;
    expect(entry).toMatchObject({ events: ['onI2.matched'], anonymous: false, contact: 'none', pid: wait.child.pid });
    expect((await queue(['waiters'])).stdout).toContain('i2.matched');

    const second = await queue(['wait', 'onI2.matched', '--name', 'i2.matched', '--timeout', '10m']);
    expect(second.exitCode).toBe(4);
    expect(second.stderr).toContain('each concurrent wait needs its own name');
    expect(second.stderr).toContain(`pid ${wait.child.pid}`);

    const push = await queue(['push', 'onI2.matched', '{"n":1}']);
    expect(push.exitCode, push.stderr).toBe(0);
    expect(push.stdout).toContain('[ok] queued (0 subscribers, 1 waiting: i2.matched)');
    expect(push.stderr).not.toContain('[warn]');

    expect(await withHangGuard(wait.exited, 'the wait i2.matched to end')).toBe(0);
    expect(wait.stdout()).toContain('[ok] onI2.matched at');
    const eventId = /eventId ([^)]+)\)/.exec(wait.stdout())?.[1];
    expect(eventId).toBeTruthy();

    const rows = await historyOf('i2.matched');
    expect(rows.map((row) => row.outcome).sort()).toEqual(['matched', 'refused']);
    expect(rows.find((row) => row.outcome === 'matched')).toMatchObject({ event: 'onI2.matched', eventId });
    expect(await liveNames()).not.toContain('i2.matched');
  });

  it('a push after the wait ended is back to the warning (nobody waits)', async () => {
    const push = await queue(['push', 'onI2.matched', '{"n":2}']);
    expect(push.exitCode).toBe(0);
    expect(push.stderr).toContain('[warn] queued');
    expect(push.stderr).toContain('no one waiting');
  });

  it('a wait that is killed is reported lost, not listed, and the next listing says so only once', async () => {
    const wait = startWait(['onI2.killed', '--name', 'i2.killed', '--timeout', '10m']);
    await waitUntilListed('i2.killed', wait);
    wait.child.kill('SIGKILL');
    await withHangGuard(wait.exited, 'the killed wait to end');

    expect(await liveNames()).not.toContain('i2.killed');
    const rows = await historyOf('i2.killed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'i2.killed', outcome: 'lost' });
    expect(rows[0]!.endedAt).toBeTruthy();
  });

  it('a wait that times out is recorded as timeout', async () => {
    const result = await queue(['wait', 'onI2.timeout', '--name', 'i2.timeout', '--timeout', '1s']);
    expect(result.exitCode).toBe(2);
    expect((await historyOf('i2.timeout')).map((row) => row.outcome)).toEqual(['timeout']);
    expect(await liveNames()).not.toContain('i2.timeout');
  });

  it('a wait without --name warns once and is listed as anon.<pid>', async () => {
    const wait = startWait(['onI2.anon', '--timeout', '10m']);
    const pid = wait.child.pid!;
    await waitUntilListed(`anon.${pid}`, wait);
    expect(wait.stderr().split('\n').filter((line) => line.startsWith('[warn] no --name'))).toHaveLength(1);
    const listed = (JSON.parse((await queue(['waiters', '--json'])).stdout) as ListedWait[]).find((candidate) => candidate.name === `anon.${pid}`)!;
    expect(listed.anonymous).toBe(true);
    expect((await queue(['waiters'])).stdout).toContain(`anon.${pid} (no --name)`);
    wait.child.kill();
    await withHangGuard(wait.exited, 'the anonymous wait to end');
  });
});
