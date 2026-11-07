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
import { abandonInFlightEntryDetailed, abandonStuckEntriesDetailed, clearDlqEntriesReturning, listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';
import type { EventEnvelope } from '../types.js';

// Loss window (emit BEFORE the DLQ row) and the dlq-notify RPC (the paths that write the files without the daemon), against a real QueueService on temp dirs.

let configDir: string;
let projectDir: string;
let registryDir: string;
let projectId: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dlqnotify-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dlqnotify-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-dlqnotify-registry-'));
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

  it('keeps the exclusion of queue.* base events and the hop cap', async () => {
    await projectWith(YAML(failingCli('queue.dlq.added')));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    // a base event named queue.* that fails: DLQ row, no event
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('q1', { event: 'queue.dlq.added', status: 'failed', attempts: 1 }, { origin: 'queue' }));
    const batch = svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('q1', { event: 'queue.dlq.added' }), reason: 'given-up' }] });
    // the row is not there: refused, as for any entry the DLQ does not hold
    expect(batch.status).toBe('rejected');
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('q1', { event: 'queue.dlq.added' }));
    expect(svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('q1', { event: 'queue.dlq.added' }), reason: 'given-up' }] })).toEqual({ status: 'ok', accepted: 1 });
    // a chain at the cap: not emitted, said in the log
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('capped', {}, { hops: 5 }));
    svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('capped', {}, { hops: 5 }), reason: 'given-up' }] });
    await waitFor('the loop guard line', () => lines.mock.calls.some((call) => call[0].message.includes('loop guard: queue.dlq.added')) && svc.isIdle());
    expect(added()).toEqual([]);
  });
});

describe('dlq-notify added (give-up from the dashboard)', () => {
  it('give-up of one in-flight entry: the event is built by the daemon (reason given-up, project, hops + 1, causedBy, no payload copy)', async () => {
    const { plugin: sink, seen } = ((): { plugin: ActionPlugin; seen: EventEnvelope[] } => {
      const list: EventEnvelope[] = [];
      return { plugin: { name: 'sink', validate: () => undefined, run: (_c, envelope) => { list.push(envelope); return Promise.resolve({ success: true }); } }, seen: list };
    })();
    await projectWith(YAML(['  queue.dlq.added:', '    - type: action', '      name: sink', '      action: sink']));
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('w1', { status: 'failed', attempts: 2, lastError: 'boom' }, { hops: 2 }));
    const moved = abandonInFlightEntryDetailed(configDir, 'w1');
    expect(moved.status).toBe('moved');
    const changes = (moved as Extract<typeof moved, { status: 'moved' }>).changes;
    expect(changes.added.map((e) => e.id)).toEqual(['w1']);

    const svc = service(sink);
    expect(svc.commands['dlq-notify']({ kind: 'added', entries: changes.added.map((entry) => ({ entry, reason: 'given-up' })) })).toEqual({ status: 'ok', accepted: 1 });
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
  });

  it('give-up of stuck entries: one event per moved entry, in a batch', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const store = new Wal(join(configDir, 'wal.ndjson'));
    for (let i = 0; i < 13; i++) {
      store.append(walEntry(`s${i}`, { timestamp: '2020-01-01T00:00:00.000Z' }));
    }
    const result = abandonStuckEntriesDetailed(configDir);
    expect(result.moved).toBe(13);
    expect(result.changes.added).toHaveLength(13);
    const svc = service();
    expect(svc.commands['dlq-notify']({ kind: 'added', entries: result.changes.added.map((entry) => ({ entry, reason: 'given-up' })) })).toEqual({ status: 'ok', accepted: 13 });
    await waitFor('13 events', () => added().length === 13 && svc.isIdle());
    expect(new Set(added().map((entry) => payloadOf(entry)['entryId'])).size).toBe(13);
  });

  it('a give-up pushing the oldest row out at the cap reports it, and the daemon announces removed(evicted)', async () => {
    await projectWith(YAML(failingCli('onNever')));
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`e${i}`))).join('\n') + '\n');
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('late', { status: 'failed', attempts: 1 }));
    const moved = abandonInFlightEntryDetailed(configDir, 'late');
    const changes = (moved as Extract<typeof moved, { status: 'moved' }>).changes;
    expect(changes.evicted.map((e) => e.id)).toEqual(['e0']);
    const svc = service();
    const response = svc.commands['dlq-notify']({
      kind: 'removed',
      entries: changes.evicted.map((entry) => ({ entry, reason: 'evicted' })),
    });
    expect(response).toEqual({ status: 'ok', accepted: 1 });
    await waitFor('the event', () => removed().length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)).toMatchObject({ entryId: 'e0', reason: 'evicted' });
  });

  it('refuses a request about a row that is not in the DLQ, or that is another delivery, and names the entry', async () => {
    await projectWith(YAML(failingCli('onNever')));
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('real'));
    const svc = service();
    const missing = svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('ghost'), reason: 'given-up' }] });
    expect(missing.status).toBe('rejected');
    expect(missing.reason).toContain('ghost');
    expect(missing.reason).toContain('Fix:');
    const otherEvent = svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('real', { event: 'onForged' }), reason: 'given-up' }] });
    expect(otherEvent.status).toBe('rejected');
    // one bad entry refuses the whole request
    const mixed = svc.commands['dlq-notify']({ kind: 'added', entries: [{ entry: dlqEntry('real'), reason: 'given-up' }, { entry: dlqEntry('ghost'), reason: 'given-up' }] });
    expect(mixed.status).toBe('rejected');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(added()).toEqual([]);
  });
});

describe('dlq-notify removed (clear from the dashboard)', () => {
  it('clear of one entry and of all: the entries returned by the clear give one removed(cleared) each', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const store = new DlqStore(join(configDir, 'dlq.ndjson'));
    for (const id of ['a', 'b', 'c']) {
      store.append(dlqEntry(id));
    }
    const one = clearDlqEntriesReturning(configDir, 'a');
    const rest = clearDlqEntriesReturning(configDir);
    const svc = service();
    expect(svc.commands['dlq-notify']({ kind: 'removed', entries: [...one, ...rest].map((entry) => ({ entry, reason: 'cleared' })) })).toEqual({ status: 'ok', accepted: 3 });
    await waitFor('3 events', () => removed().length === 3 && svc.isIdle());
    expect(removed().map((entry) => payloadOf(entry)['entryId']).sort()).toEqual(['a', 'b', 'c']);
    expect(removed().every((entry) => payloadOf(entry)['reason'] === 'cleared')).toBe(true);
    expect(removed()[0]).toMatchObject({ projectId, cwd: projectDir });
  });

  it('a reserved base event (queue.*) is accepted and emits nothing', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const svc = service();
    expect(svc.commands['dlq-notify']({ kind: 'removed', entries: [{ entry: dlqEntry('r', { event: 'queue.dlq.added' }), reason: 'cleared' }, { entry: dlqEntry('n'), reason: 'cleared' }] })).toEqual({ status: 'ok', accepted: 2 });
    await waitFor('the normal one', () => removed().length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)['entryId']).toBe('n');
  });
});

describe('dlq-notify validation (loud, nothing emitted)', () => {
  const good = (): DlqEntry => dlqEntry('x');

  it.each([
    ['no payload', undefined, 'must be an object'],
    ['an array', [], 'must be an object'],
    ['a bad kind', { kind: 'replayed', entries: [{ entry: dlqEntry('x'), reason: 'cleared' }] }, 'kind must be "added" or "removed"'],
    ['no kind', { entries: [] }, 'kind must be'],
    ['no entries', { kind: 'added' }, 'entries must be a non-empty array'],
    ['an empty list', { kind: 'removed', entries: [] }, 'entries must be a non-empty array'],
    ['an item that is not an object', { kind: 'removed', entries: ['x'] }, 'entries[0] must be an object'],
    ['a reason of the daemon alone for added', { kind: 'added', entries: [{ entry: dlqEntry('x'), reason: 'retries-exhausted' }] }, 'must be one of "given-up"'],
    ['a removed reason for added', { kind: 'added', entries: [{ entry: dlqEntry('x'), reason: 'cleared' }] }, 'must be one of "given-up"'],
    ['replayed (daemon alone) for removed', { kind: 'removed', entries: [{ entry: dlqEntry('x'), reason: 'replayed' }] }, 'must be one of "cleared", "evicted"'],
    ['no reason', { kind: 'removed', entries: [{ entry: dlqEntry('x') }] }, 'entries[0].reason'],
    ['an entry that is not an object', { kind: 'removed', entries: [{ entry: 'x', reason: 'cleared' }] }, 'entries[0].entry must be a DLQ entry'],
    ['an entry without id', { kind: 'removed', entries: [{ entry: { ...good(), id: '' }, reason: 'cleared' }] }, 'entries[0].entry.id'],
    ['an entry without event', { kind: 'removed', entries: [{ entry: { ...good(), event: undefined }, reason: 'cleared' }] }, 'entries[0].entry.event'],
    ['an entry without subscriberId', { kind: 'removed', entries: [{ entry: { ...good(), subscriberId: 3 }, reason: 'cleared' }] }, 'entries[0].entry.subscriberId'],
    ['bad attempts', { kind: 'removed', entries: [{ entry: { ...good(), attempts: -1 }, reason: 'cleared' }] }, 'entries[0].entry.attempts'],
    ['bad lastError', { kind: 'removed', entries: [{ entry: { ...good(), lastError: 1 }, reason: 'cleared' }] }, 'entries[0].entry.lastError'],
    ['no meta', { kind: 'removed', entries: [{ entry: { ...good(), meta: undefined }, reason: 'cleared' }] }, 'entries[0].entry.meta'],
    ['bad meta.eventId', { kind: 'removed', entries: [{ entry: { ...good(), meta: { eventId: 5 } }, reason: 'cleared' }] }, 'meta.eventId'],
    ['bad meta.hops', { kind: 'removed', entries: [{ entry: { ...good(), meta: { hops: 1.5 } }, reason: 'cleared' }] }, 'meta.hops'],
  ])('%s', async (_name, payload, expected) => {
    await projectWith(YAML(failingCli('onNever')));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const response = svc.commands['dlq-notify'](payload);
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain(expected);
    expect(response.reason).toContain('Nothing was emitted');
    expect(lines.mock.calls.some((call) => call[0].source === 'QueueDaemon.dlq-notify')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(removed()).toEqual([]);
    expect(added()).toEqual([]);
  });

  it('is not a push: the reserved namespace stays closed, and an origin or an event name in the request changes nothing', async () => {
    await projectWith(YAML(failingCli('onNever')));
    const svc = service();
    expect((await svc.commands.push({ event: 'queue.dlq.added', payload: {}, cwd: projectDir })).status).toBe('rejected');
    // extra fields of the request are ignored: the daemon names the event itself
    expect(svc.commands['dlq-notify']({ kind: 'removed', event: 'queue.dlq.added', origin: 'queue', entries: [{ entry: { ...dlqEntry('x'), meta: { ...dlqEntry('x').meta, origin: 'queue' } }, reason: 'cleared' }] })).toEqual({ status: 'ok', accepted: 1 });
    await waitFor('the event', () => removed().length === 1 && svc.isIdle());
    expect(added()).toEqual([]);
  });
});
