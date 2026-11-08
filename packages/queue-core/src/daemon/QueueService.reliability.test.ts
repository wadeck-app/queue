import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin, ActionResult } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { DlqStore, type DlqEntry } from '../storage/DlqStore.js';
import { listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';
import { HistoryReader } from '../storage/HistoryReader.js';

// Reliability of the daemon around the WAL: one delivery at a time per entry, a replay that cannot leave a delivered entry replayable, a retry that cannot be
// scheduled is visible, a push that is recorded whole or not at all, a DLQ row that can never be announced is marked once.

let configDir: string;
let projectDir: string;
let registryDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-reliab-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-reliab-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-reliab-registry-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [configDir, projectDir, registryDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const walFile = (): Wal => new Wal(join(configDir, 'wal.ndjson'));
const entries = (): WalEntry[] => walFile().readAll();

interface Gate {
  plugin: ActionPlugin;
  runs: string[];
  /** Releases the runs waiting on the gate. */
  release(result?: ActionResult): void;
}

/** An action `gate` that records its runs; with `hold`, every run waits for `release()` (a delivery that takes a while). */
function gate(options: { hold?: boolean; result?: ActionResult } = {}): Gate {
  const runs: string[] = [];
  const waiting: Array<(result: ActionResult) => void> = [];
  const plugin: ActionPlugin = {
    name: 'gate',
    validate: () => undefined,
    run: (config) => {
      runs.push(String(config['tag'] ?? ''));
      if (options.hold !== true) {
        return Promise.resolve(options.result ?? { success: true });
      }
      return new Promise<ActionResult>((resolve) => { waiting.push(resolve); });
    },
  };
  return { plugin, runs, release: (result = { success: true }) => { while (waiting.length > 0) waiting.shift()!(result); } };
}

const SUBSCRIBERS_ONE = ['subscribers:', '  onA:', '    - { type: action, name: one, action: gate, retries: 3, with: { tag: one } }', ''].join('\n');
const SUBSCRIBERS_THREE = [
  'subscribers:', '  onA:',
  '    - { type: action, name: one, action: gate, retries: 3, with: { tag: one } }',
  '    - { type: action, name: two, action: gate, retries: 3, with: { tag: two } }',
  '    - { type: action, name: three, action: gate, retries: 3, with: { tag: three } }', '',
].join('\n');

function start(subscribers: string, g: Gate): QueueService {
  writeFileSync(join(configDir, 'subscribers.yml'), subscribers);
  return createQueueService(configDir, { registryDir, actions: createActionRegistry([g.plugin]) });
}

const push = (service: QueueService, event = 'onA'): Promise<unknown> => service.commands.push({ event, payload: { n: 1 }, cwd: projectDir, protocol: '1.3.0' } as never);

type DiagnosticSpy = MockInstance<QueueService['eventLogger']['logDiagnostic']>;
const diagnostics = (service: QueueService): DiagnosticSpy => vi.spyOn(service.eventLogger, 'logDiagnostic');
const said = (spy: DiagnosticSpy): string[] => spy.mock.calls.map((call) => call[0].message);

describe('one entry is never delivered twice at the same time', () => {
  it('a retry of an entry whose delivery is running is refused, naming the entry; the subscriber runs once', async () => {
    const g = gate({ hold: true });
    const service = start(SUBSCRIBERS_ONE, g);
    await push(service);
    await waitFor('the delivery to start', () => g.runs.length === 1);
    const id = entries()[0]!.id;

    const response = await service.commands.retry({ eventId: id });

    expect(response.status).toBe('error');
    expect(response.message).toContain(id);
    expect(response.message).toContain('being delivered');
    g.release();
    await waitFor('the delivery to finish', () => service.isIdle() && entries()[0]!.status === 'acked');
    expect(g.runs).toHaveLength(1);
  });

  it('the guard is released when the delivery fails: a later retry runs the subscriber again', async () => {
    const g = gate({ result: { success: false, error: 'nope' } });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const service = start(SUBSCRIBERS_ONE, g);
    await push(service);
    await waitFor('the failure to be recorded', () => entries()[0]?.status === 'failed');
    // the dispatch promise settles right after the WAL write: ask again until the entry is no longer in flight
    let status = 'error';
    for (let attempt = 0; attempt < 10_000 && status !== 'ok'; attempt++) {
      status = (await service.commands.retry({ eventId: entries()[0]!.id })).status;
      if (status !== 'ok') {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    expect(status).toBe('ok');
    await waitFor('the second run', () => g.runs.length >= 2);
  });

  it('a replay is refused while the entry it re-creates is being delivered', async () => {
    const g = gate({ hold: true });
    const service = start(SUBSCRIBERS_ONE, g);
    await push(service);
    await waitFor('the delivery to start', () => g.runs.length === 1);
    const id = entries()[0]!.id;
    new DlqStore(join(configDir, 'dlq.ndjson')).append({ id, event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: entries()[0]!.subscriberId, attempts: 1, lastError: 'x', movedAt: new Date().toISOString() });

    const response = await service.commands['dlq-replay']({ id });

    expect(response.status).toBe('error');
    expect(response.message).toContain('being delivered');
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual([id]);
    g.release();
    await waitFor('the delivery to finish', () => service.isIdle());
    expect(g.runs).toHaveLength(1);
  });
});

describe('a dlq-replay that cannot finish does not leave a delivered entry replayable', () => {
  const seed = (id: string, walOverrides: Partial<WalEntry> = {}, rowOverrides: Partial<DlqEntry> = {}): DlqEntry => {
    const row: DlqEntry = { id, event: 'onA', payload: { n: 1 }, meta: { cwd: projectDir }, subscriberId: 'global/one', attempts: 3, lastError: 'seeded', movedAt: '2026-11-07T10:00:00.000Z', ...rowOverrides };
    new DlqStore(join(configDir, 'dlq.ndjson')).append(row);
    walFile().append({ id, timestamp: '2026-11-06T10:00:00.000Z', event: 'onA', payload: row.payload, meta: row.meta, subscriberId: row.subscriberId, status: 'dlq', attempts: 3, lastError: 'seeded', ...walOverrides });
    return row;
  };

  it('the row cannot be removed (injected failure): the replay answers an error, restores the WAL entry as it was, runs nothing; a second replay then delivers once', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    // learn the id the subscriber gets, then start from a clean WAL
    await push(service);
    await waitFor('the first delivery', () => service.isIdle() && entries().length === 1);
    const subscriberId = entries()[0]!.subscriberId;
    g.runs.length = 0;
    rmSync(join(configDir, 'wal.ndjson'));
    seed('r1', {}, { subscriberId });
    const before = entries();
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const remove = vi.spyOn(DlqStore.prototype, 'removeEntries').mockImplementationOnce(() => { throw new Error('EPERM: dlq.ndjson locked'); });

    const first = await service.commands['dlq-replay']({ id: 'r1' });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('error');
    expect(first.message).toContain('EPERM');
    expect(first.message).toContain('still in the dead-letter queue');
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['r1']);
    expect(entries()).toEqual(before);
    expect(g.runs).toHaveLength(0);

    const second = await service.commands['dlq-replay']({ id: 'r1' });
    expect(second.status).toBe('ok');
    await waitFor('the replay to be delivered', () => service.isIdle() && entries().find((e) => e.id === 'r1')?.status === 'acked');
    expect(g.runs).toHaveLength(1);
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('a crash between the WAL re-creation and the row removal is repaired at the next start: the row goes, the pending entry is the one that runs', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    seed('r2', { status: 'pending', attempts: 0, timestamp: '2026-11-08T10:00:00.000Z' });
    const schedule = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

    service.onStart();

    expect(listDlqEntries(configDir)).toEqual([]);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]![0]).toMatchObject({ id: 'r2' });
    await waitFor('the removed event to be recorded', () => new HistoryReader(join(configDir, 'history')).read({ event: 'queue.dlq.removed' }).length === 1);
  });

  it('a row whose WAL entry is failed (the mover crashed after the row, before the status) is left alone', () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    seed('r3', { status: 'failed', attempts: 3, timestamp: '2026-11-08T10:00:00.000Z' });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

    service.onStart();

    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['r3']);
  });
});

describe('a retry that cannot be scheduled is visible and the entry stays retryable', () => {
  it('orch missing: the failed entry says why in its lastError, with the command to run by hand; the cause is said once however many entries fail', async () => {
    const g = gate({ result: { success: false, error: 'boom' } });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => { throw new Error('orch not found on PATH. Install @wadeck/orchestrator to enable retry scheduling.'); });
    const service = start(SUBSCRIBERS_THREE, g);
    const spy = diagnostics(service);

    await push(service);
    await waitFor('three failed entries', () => entries().length === 3 && entries().every((e) => e.status === 'failed' && (e.lastError ?? '').includes('retry not scheduled')));

    for (const entry of entries()) {
      expect(entry.lastError).toContain('boom');
      expect(entry.lastError).toContain('orch not found');
      expect(entry.lastError).toContain(`queue retry --event ${entry.id}`);
    }
    expect(said(spy).filter((m) => m.includes('orch not found'))).toHaveLength(1);
    await waitFor('idle', () => service.isIdle());
  });

  it('orch fails asynchronously (exit 4): the same marking, through the error callback', async () => {
    const g = gate({ result: { success: false, error: 'boom' } });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation((_entry, _sync, options) => { options?.onError?.(new Error('could not schedule: --command is required')); });
    const service = start(SUBSCRIBERS_ONE, g);

    await push(service);
    await waitFor('the entry to be marked', () => (entries()[0]?.lastError ?? '').includes('--command is required'));

    expect(entries()[0]!.status).toBe('failed');
  });

  it('a retry that was scheduled leaves lastError as the delivery error', async () => {
    const g = gate({ result: { success: false, error: 'boom' } });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const service = start(SUBSCRIBERS_ONE, g);
    await push(service);
    await waitFor('the failure', () => entries()[0]?.status === 'failed');
    expect(entries()[0]!.lastError).toBe('boom');
  });

  it('the subscriber backoff is given to the scheduler', async () => {
    const g = gate({ result: { success: false, error: 'boom' } });
    const schedule = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
    const service = start(['subscribers:', '  onA:', '    - { type: action, name: one, action: gate, retries: 5, backoff: linear }', ''].join('\n'), g);
    await push(service);
    await waitFor('a retry to be scheduled', () => schedule.mock.calls.length === 1);
    expect(schedule.mock.calls[0]![2]).toMatchObject({ backoff: 'linear' });
  });

  it('startup: pending entries that cannot be rescheduled are marked failed (so the daemon can idle), the cause is said once, and each entry says how to run it', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    walFile().appendMany(['p1', 'p2'].map((id) => ({ id, timestamp: new Date().toISOString(), event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: 'global/one', status: 'pending' as const, attempts: 0 })));
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => { throw new Error('orch not found on PATH.'); });
    const spy = diagnostics(service);

    service.onStart();

    expect(entries().map((e) => e.status)).toEqual(['failed', 'failed']);
    expect(entries()[0]!.lastError).toContain('queue retry --event p1');
    expect(said(spy).filter((m) => m.includes('orch not found'))).toHaveLength(1);
    await waitFor('the daemon to be idle: no pending entry is left to wait for', () => service.isIdle());
  });

  it('shutdown: the same marking', () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    walFile().append({ id: 'p1', timestamp: new Date().toISOString(), event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: 'global/one', status: 'pending', attempts: 0 });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => { throw new Error('orch not found on PATH.'); });

    service.onShutdown();

    expect(entries()[0]!.status).toBe('failed');
    expect(entries()[0]!.lastError).toContain('retry not scheduled');
  });
});

// Crash recovery: a pending entry from a previous run is handed to orch at the start and at the shutdown
describe('crash recovery reschedules the pending entries', () => {
  const pending = (id: string, status: WalEntry['status'] = 'pending'): WalEntry => ({ id, timestamp: new Date().toISOString(), event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: 'global/one', status, attempts: 0 });

  it('onStart schedules each pending entry (once, asynchronously) and none of the others', () => {
    const service = start(SUBSCRIBERS_ONE, gate());
    walFile().appendMany([pending('a'), pending('b'), pending('c', 'acked'), pending('d', 'failed'), pending('e', 'dlq')]);
    const schedule = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

    service.onStart();

    expect(schedule.mock.calls.map((c) => [(c[0] as WalEntry).id, c[1] ?? false])).toEqual([['a', false], ['b', false]]);
  });

  it('onStart: orch refusing the job later (asynchronous failure) marks the entry failed with the cause and the command to run by hand', async () => {
    const service = start(SUBSCRIBERS_ONE, gate());
    walFile().append(pending('a'));
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation((_entry, _sync, options) => { options?.onError?.(new Error('orch exited with code 4: --command is required')); });

    service.onStart();

    await waitFor('the entry to be marked', () => entries()[0]?.status === 'failed');
    expect(entries()[0]!.lastError).toContain('--command is required');
    expect(entries()[0]!.lastError).toContain('queue retry --event a');
  });

  it('onShutdown schedules each pending entry synchronously (the process is about to exit)', () => {
    const service = start(SUBSCRIBERS_ONE, gate());
    walFile().appendMany([pending('a'), pending('c', 'acked')]);
    const schedule = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

    service.onShutdown();

    expect(schedule.mock.calls.map((c) => [(c[0] as WalEntry).id, c[1]])).toEqual([['a', true]]);
  });
});

describe('the due time of a retry follows the entry', () => {
  it('rescheduling a pending entry records when its retry is due, so a long wait is not taken for a stuck entry', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-08T12:00:00.000Z'));
    try {
      const service = start(SUBSCRIBERS_ONE, gate());
      walFile().append({ id: 'p1', timestamp: '2026-11-08T08:00:00.000Z', event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: 'global/one', status: 'pending', attempts: 0 });
      vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

      service.onStart();

      expect(entries()[0]!.retryDueAt).toBe('2026-11-08T12:01:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an entry whose retry could not be scheduled has no due time any more', () => {
    const service = start(SUBSCRIBERS_ONE, gate());
    walFile().append({ id: 'p1', timestamp: new Date().toISOString(), event: 'onA', payload: {}, meta: { cwd: projectDir }, subscriberId: 'global/one', status: 'pending', attempts: 0 });
    vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => { throw new Error('orch not found on PATH.'); });

    service.onStart();

    expect(entries()[0]!.status).toBe('failed');
    expect(entries()[0]!.retryDueAt).toBeUndefined();
  });
});

describe('a push is recorded whole or not at all', () => {
  it('the WAL cannot be written: the push fails with an actionable message, nothing is recorded, nothing is dispatched', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_THREE, g);
    vi.spyOn(Wal.prototype, 'appendMany').mockImplementation(() => { throw new Error('EPERM: wal.ndjson locked'); });

    await expect(push(service)).rejects.toThrow(/not recorded.*EPERM.*wal\.ndjson/s);

    expect(entries()).toEqual([]);
    expect(g.runs).toEqual([]);
    expect(service.isIdle()).toBe(true);
  });

  it('records the three entries together and dispatches all three', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_THREE, g);
    const appendMany = vi.spyOn(Wal.prototype, 'appendMany');
    await push(service);
    await waitFor('the three deliveries', () => service.isIdle() && entries().length === 3 && entries().every((e) => e.status === 'acked'));
    expect(appendMany).toHaveBeenCalledTimes(1);
    expect(g.runs.sort()).toEqual(['one', 'three', 'two']);
  });
});

describe('a delivery whose acknowledgement cannot be written keeps the daemon awake and is written later', () => {
  it('isIdle writes the kept-aside acknowledgement once the WAL is writable again, and only then reports idle', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    const spy = diagnostics(service);
    const update = vi.spyOn(Wal.prototype, 'updateEntryIf').mockImplementation(() => { throw new Error('EPERM: wal.ndjson locked'); });

    await push(service);
    await waitFor('the delivery to have run', () => g.runs.length === 1 && said(spy).some((m) => m.includes('could not be written')));

    expect(service.isIdle()).toBe(false);
    expect(entries()[0]!.status).toBe('pending');

    update.mockRestore();
    await waitFor('the acknowledgement to be written', () => service.isIdle());
    expect(entries()[0]!.status).toBe('acked');
    expect(g.runs).toHaveLength(1);
  });

  it('the shutdown tries once more to write it before rescheduling, so a delivered entry is not rescheduled', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    const spy = diagnostics(service);
    const update = vi.spyOn(Wal.prototype, 'updateEntryIf').mockImplementation(() => { throw new Error('EPERM: wal.ndjson locked'); });
    await push(service);
    await waitFor('the delivery to have run', () => g.runs.length === 1 && said(spy).some((m) => m.includes('could not be written')));
    update.mockRestore();
    const schedule = vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);

    service.onShutdown();

    expect(entries()[0]!.status).toBe('acked');
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('a DLQ row that can never be announced is marked once, not retried on every push', () => {
  const orphan = (id: string): DlqEntry => ({
    id, event: 'onA', payload: {}, meta: { cwd: projectDir, projectId: 'long-gone-project', eventId: `evt-${id}` }, subscriberId: 'long-gone-project/one', attempts: 3,
    lastError: 'seeded', movedAt: '2026-11-07T10:00:00.000Z', announce: 'pending', announceInfo: { reason: 'retries-exhausted' },
  });

  it('the project of the row is not registered any more: the row becomes unannounceable with the reason, and no later push scans it again', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    new DlqStore(join(configDir, 'dlq.ndjson')).append(orphan('o1'));
    const spy = diagnostics(service);

    service.onStart();
    await waitFor('the row to be marked', () => listDlqEntries(configDir)[0]?.announce === 'unannounceable');

    const row = listDlqEntries(configDir)[0]!;
    expect(row.announceReason).toContain('long-gone-project');
    expect(row.announceReason).toContain('not registered');
    expect(said(spy).filter((m) => m.includes('o1') && m.includes('unannounceable'))).toHaveLength(1);

    // a later successful push does not look at it again
    const readAll = vi.spyOn(DlqStore.prototype, 'readAll');
    await push(service);
    await waitFor('idle', () => service.isIdle());
    expect(readAll.mock.calls.length).toBe(0);
    expect(said(spy).filter((m) => m.includes('o1') && m.includes('unannounceable'))).toHaveLength(1);
  });

  it('an unreadable registry is a temporary problem: the row stays pending', async () => {
    const g = gate();
    const service = start(SUBSCRIBERS_ONE, g);
    new DlqStore(join(configDir, 'dlq.ndjson')).append(orphan('o2'));
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');

    service.onStart();
    await waitFor('the scan to finish', () => service.isIdle());

    expect(listDlqEntries(configDir)[0]!.announce).toBe('pending');
  });
});
