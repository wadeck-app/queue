import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createQueueClient } from './QueueClient.js';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { runQueueCli, type CliResult } from '../testing/runCli.js';
import { waitFor, waitForPortFree } from '../testWaitFor.js';

// queue.dlq.added / queue.dlq.removed against a REAL daemon: the bundled CLI and daemon, a throwaway config dir, home and registry (createIsolatedCliEnv).
// A failing cli subscriber gives up -> the daemon emits queue.dlq.added with a reference to the base event; a subscriber template follows the reference
// byte-exact; replay, clear and the give-up of the dashboard (the give-up RPC) are announced; with no subscriber on queue.dlq.* the history still records the events.


// A title with a quote, a space and a shell metacharacter: it must reach the script as ONE argument, unchanged
const TITLE = 'a"b & c';

let iso: IsolatedCliEnv | undefined;
let work = '';

afterEach(async () => {
  if (iso !== undefined) {
    runCli(['stop']);
    // The daemon of this test runs on the port createIsolatedCliEnv allocated for it (QUEUE_DAEMON_PORT): no other daemon is involved
    await waitForPortFree(iso.daemonPort);
    iso.cleanup();
    iso = undefined;
  }
});

function env(): IsolatedCliEnv {
  if (iso === undefined) {
    throw new Error('isolated CLI environment not initialised: the test must call setup() first');
  }
  return iso;
}

function runCli(args: string[]): CliResult {
  return runQueueCli(env().env, args, { cwd: work === '' ? undefined : work });
}

/** Creates the throwaway environment, the helper scripts and the global subscribers.yml; `withDlqSubscribers` adds the two subscribers on queue.dlq.*. */
function setup(withDlqSubscribers: boolean): void {
  iso = createIsolatedCliEnv();
  work = join(iso.root, 'work');
  mkdirSync(work, { recursive: true });
  // The guard of the subscribers refuses `node -e`: small script files instead
  writeFileSync(join(work, 'fail.cjs'), 'process.exit(3);\n');
  writeFileSync(join(work, 'echo-arg.cjs'), "require('node:fs').appendFileSync(require('node:path').join(__dirname, 'received.ndjson'), JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  const node = `"${process.execPath}"`;
  const command = (script: string, template: string): string => JSON.stringify(`${node} "${join(work, script)}" ${template}`);
  const lines = [
    'subscribers:',
    '  demo.fail:',
    '    - type: cli',
    '      name: failing',
    `      command: ${command('fail.cjs', '')}`,
    '      retries: 0',
  ];
  if (withDlqSubscribers) {
    lines.push(
      '  queue.dlq.added:',
      '    - type: cli',
      '      name: on-added',
      `      command: ${command('echo-arg.cjs', 'added {{ payload.original.title }} {{ payload.reason }}')}`,
      '  queue.dlq.removed:',
      '    - type: cli',
      '      name: on-removed',
      `      command: ${command('echo-arg.cjs', 'removed {{ payload.entryId }} {{ payload.reason }}')}`,
    );
  }
  writeFileSync(join(iso.configDir, 'subscribers.yml'), lines.join('\n') + '\n');
}

interface WaitResult {
  matched: boolean;
  entry: { eventId: string; event: string; totalCount: number; payload: Record<string, unknown> };
}

/** `queue wait <event> --since 10m --json`: answers at once when the event was recorded, so there is no race with the daemon. */
function waitForEvent(event: string): WaitResult {
  const result = runCli(['wait', event, '--since', '10m', '--timeout', '120s', '--json']);
  expect(result.exitCode, `queue wait ${event} failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as WaitResult;
}

interface HistoryPage {
  entries: Array<{ eventId: string; event: string; totalCount: number; payload?: Record<string, unknown> }>;
  total: number;
}

function history(event: string): { page: HistoryPage; raw: string } {
  const result = runCli(['history', '--event', event, '--json']);
  expect(result.exitCode, `queue history failed: ${result.stderr}`).toBe(0);
  return { page: JSON.parse(result.stdout) as HistoryPage, raw: result.stdout };
}

/** What the subscribers of queue.dlq.* received, one argv per line, once there are `count` of them. */
async function receivedArgs(count: number): Promise<string[][]> {
  const file = join(work, 'received.ndjson');
  return waitFor(() => {
    if (!existsSync(file)) {
      return undefined;
    }
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    return lines.length >= count ? lines.map((line) => JSON.parse(line) as string[]) : undefined;
  }, `${count} line(s) written by the subscribers of queue.dlq.* in ${file}`);
}

function startAndFail(): { baseEventId: string; added: WaitResult } {
  const start = runCli(['start']);
  expect(start.exitCode, `queue start failed: ${start.stderr}`).toBe(0);
  const push = runCli(['push', 'demo.fail', JSON.stringify({ title: TITLE })]);
  expect(push.exitCode, `queue push failed: ${push.stderr}`).toBe(0);
  const added = waitForEvent('queue.dlq.added');
  return { baseEventId: added.entry.payload['eventId'] as string, added };
}

describe('queue.dlq.* against a real daemon (integration)', () => {
  it('a failing subscriber gives up: queue.dlq.added with a reference, a template reads the base title byte-exact, replay, clear and the dashboard give-up are announced', async () => {
    setup(true);
    const { baseEventId, added } = startAndFail();

    // the facts of the event, and a reference instead of a copy of the base payload
    expect(added.entry.event).toBe('queue.dlq.added');
    expect(added.entry.payload).toMatchObject({ event: 'demo.fail', subscriberId: 'failing', reason: 'retries-exhausted', attempts: 1, exitCode: 3, original: { $eventRef: baseEventId } });
    const recorded = history('queue.dlq.added');
    expect(recorded.page.total).toBe(1);
    // (the subscriber's target in the history shows its template text, so the check is on the payload of the event)
    expect(JSON.stringify(recorded.page.entries[0]!.payload)).not.toContain('title');
    expect(recorded.raw).not.toContain('b & c');
    expect(recorded.page.entries[0]!.payload).toMatchObject({ original: { $eventRef: baseEventId } });

    // the subscriber on queue.dlq.added received the title of the BASE event through the lazy reference, as one argument, unchanged
    expect(await receivedArgs(1)).toEqual([['added', TITLE, 'retries-exhausted']]);

    // the base event is one command away
    const base = runCli(['history', '--event-id', baseEventId, '--json']);
    expect(base.exitCode, base.stderr).toBe(0);
    expect(JSON.parse(base.stdout)).toMatchObject({ eventId: baseEventId, event: 'demo.fail', payload: { title: TITLE } });

    // replay: removed(replayed), then (it fails again) added again with the same entry id
    const dlq = JSON.parse(runCli(['dlq', 'list']).stdout) as Array<{ id: string }>;
    expect(dlq).toHaveLength(1);
    const entryId = dlq[0]!.id;
    const replay = runCli(['dlq', 'replay', '--id', entryId]);
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(await receivedArgs(3)).toEqual([['added', TITLE, 'retries-exhausted'], ['removed', entryId, 'replayed'], ['added', TITLE, 'retries-exhausted']]);

    // clear: removed(cleared), emitted once
    const clear = runCli(['dlq', 'clear']);
    expect(clear.stdout).toContain('[ok] cleared 1 entries');
    expect(await receivedArgs(4)).toEqual(expect.arrayContaining([['removed', entryId, 'cleared']]));

    // the dashboard gives up a stuck entry: the daemon runs the move ITSELF (the request carries the id and nothing else) and emits the event from the row it moved
    // (a WAL line, as the daemon writes it: Wal itself is not part of the public API of queue-core)
    appendFileSync(join(env().configDir, 'wal.ndjson'), JSON.stringify({
      id: 'stuck-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      event: 'demo.fail',
      payload: { title: 'not the one a subscriber sees' },
      meta: { cwd: work, eventId: baseEventId },
      subscriberId: 'failing',
      status: 'pending',
      attempts: 0,
    }) + '\n');
    const client = createQueueClient(env().configDir);
    // a forged body: the entries, the reason and the project it names are ignored, only the id counts
    const moved = await client.send('give-up', { id: 'stuck-1', kind: 'added', reason: 'retries-exhausted', entries: [{ entry: { id: 'forged', event: 'onForged', subscriberId: 'evil', meta: { cwd: '/elsewhere' } }, reason: 'given-up' }] });
    expect(moved).toEqual({ status: 'moved' });
    expect(await receivedArgs(5)).toEqual(expect.arrayContaining([['added', TITLE, 'given-up']]));

    // the daemon answers what it did not move, and has no dlq-notify command any more
    expect(await client.send('give-up', { id: 'ghost' })).toEqual({ status: 'not-found' });
    expect(await client.send('give-up', { id: 'stuck-1' })).toEqual({ status: 'not-in-flight' });
    await expect((client.send as (command: string, payload?: unknown) => Promise<unknown>)('dlq-notify', { kind: 'added', entries: [] })).rejects.toThrow();
    // and the reserved namespace is closed to a push
    const pushed = runCli(['push', 'queue.dlq.added', '{}']);
    expect(pushed.exitCode).not.toBe(0);

    // exactly one event per change: 3 added (failure, replay failure, give-up), 2 removed (replay, clear)
    const addedAll = history('queue.dlq.added').page;
    const removedAll = history('queue.dlq.removed').page;
    expect(addedAll.total).toBe(3);
    expect(removedAll.total).toBe(2);
    expect(removedAll.entries.map((entry) => entry.payload?.['reason']).sort()).toEqual(['cleared', 'replayed']);
  });

  it('with NO subscriber on queue.dlq.* the history still records the events, and the base event is found by id', async () => {
    setup(false);
    const { baseEventId, added } = startAndFail();
    expect(added.entry.totalCount).toBe(0);
    expect(added.entry.payload).toMatchObject({ reason: 'retries-exhausted', original: { $eventRef: baseEventId } });
    expect(history('queue.dlq.added').page.total).toBe(1);

    const clear = runCli(['dlq', 'clear']);
    expect(clear.stdout).toContain('[ok] cleared 1 entries');
    const removed = waitForEvent('queue.dlq.removed');
    expect(removed.entry.totalCount).toBe(0);
    expect(removed.entry.payload).toMatchObject({ reason: 'cleared', eventId: baseEventId });
    expect(history('queue.dlq.removed').page.total).toBe(1);

    const base = runCli(['history', '--event-id', baseEventId, '--json']);
    expect(JSON.parse(base.stdout)).toMatchObject({ event: 'demo.fail', payload: { title: TITLE } });
    // nobody ran anything for the two events
    expect(existsSync(join(work, 'received.ndjson'))).toBe(false);
  });
});
