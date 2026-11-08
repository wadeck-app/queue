import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { DlqStore, type DlqEntry } from '../storage/DlqStore.js';
import { HistoryReader, type HistoryEntry } from '../storage/HistoryReader.js';
import { listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';
import type { EventEnvelope } from '../types.js';

// The loss window (emit BEFORE the DLQ row) and the daemon RPCs `give-up` / `give-up-stuck`, which run the operation themselves and emit the events from what they moved.
// No client can supply the data an event is built from: the RPCs take an id (or nothing) and the daemon reads everything else from its own files.

let configDir: string;
let projectDir: string;
let registryDir: string;
let projectId: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dlqgiveup-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dlqgiveup-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-dlqgiveup-registry-'));
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
  projectId = 'no-project';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [configDir, projectDir, registryDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const wal = (): WalEntry[] => new Wal(join(configDir, 'wal.ndjson')).readAll();
const history = (): HistoryReader => new HistoryReader(join(configDir, 'history'));
const emitted = (event: string): HistoryEntry[] => history().read({ event }).reverse();
const added = (): HistoryEntry[] => emitted('queue.dlq.added');
const removed = (): HistoryEntry[] => emitted('queue.dlq.removed');
const payloadOf = (entry: HistoryEntry): Record<string, unknown> => entry.payload as Record<string, unknown>;

async function projectWith(yml: string): Promise<string> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
  projectId = project.id;
  return project.id;
}

function service(...plugins: ActionPlugin[]): QueueService {
  return createQueueService(configDir, { registryDir, actions: createActionRegistry(plugins) });
}

function failingCli(event: string, name = 'f'): string[] {
  const script = join(projectDir, 'fail.js');
  writeFileSync(script, 'process.exit(3);');
  const command = `"${process.execPath}" "${script}"`;
  return [`  ${event}:`, '    - type: cli', `      name: ${name}`, `      command: ${JSON.stringify(command)}`, '      retries: 0'];
}

const YAML = (...blocks: string[][]): string => ['subscribers:', ...blocks.flat(), ''].join('\n');

function walEntry(id: string, overrides: Partial<WalEntry> = {}, meta: Partial<WalEntry['meta']> = {}): WalEntry {
  return {
    id,
    timestamp: '2026-11-07T10:00:00.000Z',
    event: 'onSeed',
    payload: { secret: `payload-of-${id}` },
    meta: { cwd: projectDir, projectId, eventId: `evt-${id}`, ...meta },
    subscriberId: `${projectId}/old`,
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

function dlqEntry(id: string, overrides: Partial<DlqEntry> = {}, meta: Partial<DlqEntry['meta']> = {}): DlqEntry {
  return {
    id,
    event: 'onSeed',
    payload: { secret: `payload-of-${id}` },
    meta: { cwd: projectDir, projectId, eventId: `evt-${id}`, ...meta },
    subscriberId: `${projectId}/old`,
    attempts: 1,
    lastError: 'seeded',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

function sinkPlugin(): { plugin: ActionPlugin; seen: EventEnvelope[] } {
  const seen: EventEnvelope[] = [];
  return { plugin: { name: 'sink', validate: () => undefined, run: (_c, envelope) => { seen.push(envelope); return Promise.resolve({ success: true }); } }, seen };
}

describe('queue.dlq.added is emitted BEFORE the DLQ row (no loss window)', () => {
  it('a crash between the emit and the row: the event exists, the WAL entry is retryable, the retry after a restart ends with ONE row and a duplicate event, never a loss', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    // The write of the row fails once: stands for the process dying right there
    let addedWhenRowWasWritten = -1;
    let rowsWhenRowWasWritten = -1;
    const append = vi.spyOn(DlqStore.prototype, 'append').mockImplementationOnce(() => {
      addedWhenRowWasWritten = added().length;
      rowsWhenRowWasWritten = listDlqEntries(configDir).length;
      throw new Error('simulated crash between the emit and the DLQ write');
    });
    const first = service();
    const lines = vi.spyOn(first.eventLogger, 'logDiagnostic');
    await first.commands.push({ event: 'onFoo', payload: { n: 1 }, cwd: projectDir });
    await waitFor('the failed move to be reported', () => lines.mock.calls.some((call) => call[0].message.includes('simulated crash')));

    // the event was recorded when the row was about to be written, and there was no row yet
    expect(addedWhenRowWasWritten).toBe(1);
    expect(rowsWhenRowWasWritten).toBe(0);
    expect(added()).toHaveLength(1);
    expect(listDlqEntries(configDir)).toEqual([]);
    const stranded = wal().find((entry) => entry.status === 'failed')!;
    expect(stranded).toBeDefined();
    expect(payloadOf(added()[0]!)['entryId']).toBe(stranded.id);

    // Restart on the same directory: a new service, the file state is all it has. The failed WAL entry is run again (what `queue retry` does)
    append.mockRestore();
    const second = service();
    second.onStart();
    expect(await second.commands.retry({ eventId: stranded.id })).toEqual({ status: 'ok' });
    await waitFor('the retry to end in the DLQ', () => second.isIdle() && wal().find((entry) => entry.id === stranded.id)!.status === 'dlq');

    expect(listDlqEntries(configDir)).toHaveLength(1);
    expect(listDlqEntries(configDir)[0]!.id).toBe(stranded.id);
    // at-least-once: the same entry announced twice, none lost
    expect(added().length).toBeGreaterThanOrEqual(1);
    expect(added().map((entry) => payloadOf(entry)['entryId'])).toEqual([stranded.id, stranded.id]);
  });

  it('a crash after the row was written (WAL still failed): the retry finds the row and emits nothing more', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the move', () => svc.isIdle() && added().length === 1 && wal().some((entry) => entry.status === 'dlq'));
    // put the WAL back in the state of a process that died right after dlq.append
    const entry = wal()[0]!;
    new Wal(join(configDir, 'wal.ndjson')).updateEntry(entry.id, { status: 'failed' });

    const restarted = service();
    expect(await restarted.commands.retry({ eventId: entry.id })).toEqual({ status: 'ok' });
    await waitFor('the retry', () => restarted.isIdle() && wal()[0]!.status === 'dlq');
    expect(added()).toHaveLength(1);
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });
});

describe('RPC give-up (the daemon runs the move and emits what it moved)', () => {
  it('one in-flight entry: moved, and exactly one added(given-up) built from the row the daemon moved (project, hops + 1, causedBy, no payload copy)', async () => {
    const { plugin: sink, seen } = sinkPlugin();
    await projectWith(YAML(['  queue.dlq.added:', '    - type: action', '      name: sink', '      action: sink']));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('w1', { status: 'failed', attempts: 2, lastError: 'boom' }, { hops: 2 }));

    const svc = service(sink);
    expect(svc.commands['give-up']({ id: 'w1' })).toEqual({ status: 'moved' });
    await waitFor('the event and its subscriber', () => added().length === 1 && seen.length === 1 && svc.isIdle());
    expect(payloadOf(added()[0]!)).toEqual({
      entryId: 'w1',
      eventId: 'evt-w1',
      event: 'onSeed',
      subscriberId: `${projectId}/old`,
      projectId,
      reason: 'given-up',
      error: 'boom (given up by hand)',
      attempts: 2,
      original: { $eventRef: 'evt-w1' },
    });
    expect(added()[0]).toMatchObject({ projectId, cwd: projectDir, causedBy: { eventId: 'evt-w1', subscriberId: `${projectId}/old` } });
    expect(seen[0]!.meta).toMatchObject({ hops: 3, origin: 'queue' });
    expect(JSON.stringify(added()[0]!.payload)).not.toContain('payload-of-w1');
    // emitted: the mark is gone
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announce');
    expect(wal().find((entry) => entry.id === 'w1')!.status).toBe('dlq');
  });

  it('answers not-found and not-in-flight like the file operation, and emits nothing', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('done', { status: 'acked', ackedAt: new Date().toISOString() }));
    const svc = service();
    expect(svc.commands['give-up']({ id: 'nope' })).toEqual({ status: 'not-found' });
    expect(svc.commands['give-up']({ id: 'done' })).toEqual({ status: 'not-in-flight' });
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(added()).toEqual([]);
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('refuses a request without a usable id, with an actionable reason, and moves nothing', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('w1'));
    const svc = service();
    for (const bad of [undefined, {}, { id: '' }, { id: 7 }, []]) {
      const response = svc.commands['give-up'](bad);
      expect(response.status).toBe('rejected');
      expect(response.reason).toContain('Fix:');
    }
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('a forged request body is ignored: entries, meta, kind, reason, origin or a time limit change nothing, the daemon reads its own files', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('real', { status: 'failed', attempts: 1, lastError: 'real error' }));
    const svc = service();
    const forged = {
      id: 'real',
      kind: 'added',
      reason: 'retries-exhausted',
      origin: 'queue',
      event: 'queue.dlq.added',
      entries: [{ entry: dlqEntry('forged', { event: 'onForged', subscriberId: 'evil/sub' }, { eventId: 'forged-ref', cwd: '/elsewhere', projectId: 'other', hops: 0 }), reason: 'cleared' }],
      meta: { eventId: 'forged-ref', cwd: '/elsewhere', projectId: 'other', hops: 0 },
      causedBy: { eventId: 'x', subscriberId: 'y' },
    };
    expect(svc.commands['give-up'](forged)).toEqual({ status: 'moved' });
    await waitFor('the one event', () => added().length === 1 && svc.isIdle());
    expect(payloadOf(added()[0]!)).toMatchObject({ entryId: 'real', eventId: 'evt-real', reason: 'given-up', projectId, subscriberId: `${projectId}/old`, error: 'real error (given up by hand)' });
    expect(added()[0]).toMatchObject({ cwd: projectDir, projectId });
    expect(JSON.stringify(added()[0])).not.toContain('forged');
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['real']);
    expect(removed()).toEqual([]);
  });

  it('asked N times for the same entry: one event (the second answer is not-in-flight)', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('w1', { status: 'failed' }));
    const svc = service();
    const answers = Array.from({ length: 25 }, () => svc.commands['give-up']({ id: 'w1' }).status);
    expect(answers.filter((status) => status === 'moved')).toHaveLength(1);
    await waitFor('the event', () => added().length === 1 && svc.isIdle());
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(added()).toHaveLength(1);
  });

  it('a give-up pushing the oldest row out at the cap emits removed(evicted) for it, and the evicted payload leaves the WAL', async () => {
    await projectWith(YAML(failingCli('onNever')));
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`e${i}`))).join('\n') + '\n');
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('e0', { status: 'dlq' }));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('late', { status: 'failed', attempts: 1 }));
    const svc = service();
    expect(svc.commands['give-up']({ id: 'late' })).toEqual({ status: 'moved' });
    await waitFor('both events', () => added().length === 1 && removed().length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)).toMatchObject({ entryId: 'e0', reason: 'evicted' });
    expect(payloadOf(added()[0]!)).toMatchObject({ entryId: 'late', reason: 'given-up' });
    expect(wal().some((entry) => entry.id === 'e0')).toBe(false);
  });

  it('an entry whose base event is a queue.* event is moved without an event, and one at the hop cap is moved, marked skipped and said in the log', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const store = new Wal(join(configDir, 'wal.ndjson'));
    store.append(walEntry('q1', { event: 'queue.dlq.added', status: 'failed', attempts: 1 }, { origin: 'queue' }));
    store.append(walEntry('capped', { status: 'failed', attempts: 1 }, { hops: 5 }));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    expect(svc.commands['give-up']({ id: 'q1' })).toEqual({ status: 'moved' });
    expect(svc.commands['give-up']({ id: 'capped' })).toEqual({ status: 'moved' });
    await waitFor('the loop guard line', () => lines.mock.calls.some((call) => call[0].message.includes('loop guard: queue.dlq.added')) && svc.isIdle());
    expect(added()).toEqual([]);
    const rows = listDlqEntries(configDir);
    expect(rows.find((row) => row.id === 'capped')).toMatchObject({ announce: 'skipped' });
    expect(rows.find((row) => row.id === 'q1')).not.toHaveProperty('announce');
  });
});

describe('RPC give-up-stuck', () => {
  it('moves every stuck entry (and only those) and emits one added(given-up) per moved row, in batches', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const store = new Wal(join(configDir, 'wal.ndjson'));
    for (let i = 0; i < 13; i++) {
      store.append(walEntry(`s${i}`, { timestamp: '2020-01-01T00:00:00.000Z' }));
    }
    store.append(walEntry('fresh', { status: 'failed', timestamp: new Date().toISOString() }));
    const svc = service();
    expect(svc.commands['give-up-stuck']({})).toEqual({ moved: 13 });
    await waitFor('13 events', () => added().length === 13 && svc.isIdle());
    expect(new Set(added().map((entry) => payloadOf(entry)['entryId'])).size).toBe(13);
    expect(wal().find((entry) => entry.id === 'fresh')!.status).toBe('failed');
    // the same call again moves nothing and emits nothing more
    expect(svc.commands['give-up-stuck']({})).toEqual({ moved: 0 });
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(added()).toHaveLength(13);
  });

  it('ignores a forged body: a time limit of 0 or a list of entries does not make recent entries stuck or add events', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('fresh', { status: 'failed', timestamp: new Date().toISOString() }));
    const svc = service();
    expect(svc.commands['give-up-stuck']({ olderThanMs: 0, entries: [{ entry: dlqEntry('forged'), reason: 'given-up' }], kind: 'added' })).toEqual({ moved: 0 });
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(added()).toEqual([]);
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('works without a body at all', () => {
    const svc = service();
    expect(svc.commands['give-up-stuck']()).toEqual({ moved: 0 });
  });
});

describe('the RPC dlq-notify does not exist any more (no client supplies the data of an event)', () => {
  it('is not a command of the service', () => {
    const svc = service();
    expect(Object.keys(svc.commands)).not.toContain('dlq-notify');
    expect(Object.keys(svc.commands)).toEqual(expect.arrayContaining(['dlq-clear', 'dlq-replay', 'give-up', 'give-up-stuck']));
  });
});

describe('dlq-clear stays bounded', () => {
  it('a clear of 1000 entries answers at once, then emits one removed(cleared) per entry exactly once, with the WAL payloads gone', async () => {
    await projectWith(YAML(failingCli('onNever')));
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`c${i}`))).join('\n') + '\n');
    const store = new Wal(join(configDir, 'wal.ndjson'));
    store.append(walEntry('c0', { status: 'dlq' }));
    store.append(walEntry('c999', { status: 'dlq' }));
    const svc = service();
    expect(svc.commands['dlq-clear']({})).toEqual({ cleared: 1000 });
    // the daemon is not idle while the batches run
    expect(svc.isIdle()).toBe(false);
    await waitFor('the 1000 events', () => removed().length === 1000 && svc.isIdle());
    expect(new Set(removed().map((entry) => payloadOf(entry)['entryId'])).size).toBe(1000);
    expect(listDlqEntries(configDir)).toEqual([]);
    expect(wal().filter((entry) => entry.status === 'dlq')).toEqual([]);
  }, 120_000);
});

describe('the WAL does not keep what left the DLQ for good', () => {
  it('a row pushed out at the cap by a failing dispatch takes its WAL entry with it', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`e${i}`))).join('\n') + '\n');
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('e0', { status: 'dlq' }));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the eviction event', () => removed().length === 1 && svc.isIdle());
    expect(wal().some((entry) => entry.id === 'e0')).toBe(false);
  });

  it('onStart removes the status-dlq WAL entries no row refers to when they are older than a day, and keeps the others', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const store = new Wal(join(configDir, 'wal.ndjson'));
    store.append(walEntry('orphan-old', { status: 'dlq', timestamp: '2020-01-01T00:00:00.000Z' }));
    store.append(walEntry('orphan-young', { status: 'dlq', timestamp: new Date().toISOString() }));
    store.append(walEntry('has-row', { status: 'dlq', timestamp: '2020-01-01T00:00:00.000Z' }));
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('has-row'));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    svc.onStart();
    expect(wal().map((entry) => entry.id).filter((id) => id !== 'x')).toEqual(['orphan-young', 'has-row']);
    expect(lines.mock.calls.some((call) => call[0].message.includes('removed 1 WAL entry in status dlq'))).toBe(true);
  });
});

describe('dlq-clear refuses an id that is not a non-empty string (it never means "everything")', () => {
  it.each([[''], [null], [0], [{}]])('id %j: nothing cleared, the answer says why', (id) => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqEntry('keep-1'), dlqEntry('keep-2')].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const answer = service().commands['dlq-clear']({ id }) as { cleared: number; reason?: string };
    expect(answer.cleared).toBe(0);
    expect(answer.reason).toMatch(/non-empty string/);
    expect(answer.reason).toMatch(/omit the id/);
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['keep-1', 'keep-2']);
  });

  it('an absent id clears everything, an unknown id clears 0 without a reason', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqEntry('one'), dlqEntry('two')].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const svc = service();
    expect(svc.commands['dlq-clear']({ id: 'unknown' })).toEqual({ cleared: 0 });
    expect(listDlqEntries(configDir)).toHaveLength(2);
    expect(svc.commands['dlq-clear']({})).toEqual({ cleared: 2 });
    expect(svc.commands['dlq-clear'](undefined)).toEqual({ cleared: 0 });
  });
});
