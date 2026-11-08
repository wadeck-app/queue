import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin, ActionResult } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { readCatalog } from '../catalog/EventCatalog.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { DlqStore, type DlqEntry } from '../storage/DlqStore.js';
import { HistoryReader, type HistoryEntry } from '../storage/HistoryReader.js';
import { listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';
import type { EventEnvelope } from '../types.js';
import { seededDlqEntry } from '../queueEntries.testUtil.js';

// The queue.dlq.added / queue.dlq.removed events, emitted by the daemon, against a real QueueService on temp dirs (real WAL, DLQ, history, child processes).

let configDir: string;
let projectDir: string;
let registryDir: string;
let projectId: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dlqev-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dlqev-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-dlqev-registry-'));
  // A failed dispatch would call orch to schedule a retry: nothing here needs a real one
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
/** The triggers of one event name, oldest first. */
const emitted = (event: string): HistoryEntry[] => history().read({ event }).reverse();
const added = (): HistoryEntry[] => emitted('queue.dlq.added');
const removed = (): HistoryEntry[] => emitted('queue.dlq.removed');
const payloadOf = (entry: HistoryEntry): Record<string, unknown> => entry.payload as Record<string, unknown>;

/** Registers `projectDir` with this subscribers.yml; returns the project id. */
async function projectWith(yml: string): Promise<string> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
  projectId = project.id;
  return project.id;
}

function plugin(name: string, behave: (call: number) => ActionResult = () => ({ success: true })): { plugin: ActionPlugin; seen: EventEnvelope[] } {
  const seen: EventEnvelope[] = [];
  return {
    plugin: {
      name,
      validate: () => undefined,
      run: (_config, envelope) => {
        seen.push(envelope);
        return Promise.resolve(behave(seen.length));
      },
    },
    seen,
  };
}

function service(...plugins: ActionPlugin[]): QueueService {
  return createQueueService(configDir, { registryDir, actions: createActionRegistry(plugins) });
}

const FAIL_SCRIPT = (): string => {
  const script = join(projectDir, 'fail.js');
  writeFileSync(script, 'process.exit(3);');
  return script;
};

/** A cli subscriber that always fails with exit code 3. */
function failingCli(event: string, name = 'f', extra: string[] = ['      retries: 0']): string[] {
  const command = `"${process.execPath}" "${FAIL_SCRIPT()}"`;
  return [`  ${event}:`, '    - type: cli', `      name: ${name}`, `      command: ${JSON.stringify(command)}`, ...extra];
}

const YAML = (...blocks: string[][]): string => ['subscribers:', ...blocks.flat(), ''].join('\n');

const dlqEntry = (id: string, overrides: Partial<DlqEntry> = {}, meta: Partial<DlqEntry['meta']> = {}): DlqEntry => seededDlqEntry({ cwd: projectDir, projectId }, id, overrides, meta);

/** Writes the DLQ file directly (the store itself rewrites the file on each append: too slow for a thousand). */
function seedDlq(entries: DlqEntry[]): void {
  writeFileSync(join(configDir, 'dlq.ndjson'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

describe('queue.dlq.added', () => {
  it('is emitted with NO subscriber on it: the history holds it, attributed to the project and directory of the failing dispatch', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    const svc = service();
    const push = await svc.commands.push({ event: 'onFoo', payload: { taskId: 'T-42' }, cwd: projectDir });
    await waitFor('the event in the history', () => added().length === 1 && svc.isIdle());

    const [entry] = listDlqEntries(configDir);
    const [trigger] = added();
    expect(payloadOf(trigger!)).toEqual({
      entryId: entry!.id,
      eventId: push.eventId,
      event: 'onFoo',
      subscriberId: `${projectId}/f`,
      projectId,
      reason: 'retries-exhausted',
      error: entry!.lastError,
      attempts: 1,
      exitCode: 3,
      target: expect.stringContaining('fail.js'),
      original: { $eventRef: push.eventId },
    });
    expect(trigger).toMatchObject({ projectId, cwd: projectDir, matchedCount: 0, totalCount: 0, causedBy: { eventId: push.eventId, subscriberId: `${projectId}/f` } });
    expect(wal().find((e) => e.id === entry!.id)!.status).toBe('dlq');
    // the event never copies the base payload
    expect(JSON.stringify(trigger!.payload)).not.toContain('T-42');
  });

  it('retries exhausted: exactly one event, only when the last attempt failed', async () => {
    await projectWith(YAML(failingCli('onFoo', 'f', ['      retries: 2'])));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the first failure', () => svc.isIdle() && wal().some((e) => e.status === 'failed'));
    expect(added()).toEqual([]);
    expect(listDlqEntries(configDir)).toEqual([]);

    const failed = wal().find((e) => e.status === 'failed')!;
    expect(await svc.commands.retry({ eventId: failed.id })).toEqual({ status: 'ok' });
    await waitFor('the entry in the DLQ and its event', () => svc.isIdle() && added().length === 1);
    expect(payloadOf(added()[0]!)).toMatchObject({ reason: 'retries-exhausted', attempts: 2, entryId: failed.id });
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });

  it('permanent failure: the reason says so, even on the first attempt of a subscriber with retries left', async () => {
    const { plugin: boom } = plugin('boom', () => ({ success: false, error: 'refused for good', permanent: true }));
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: b', '      action: boom', ''].join('\n'));
    const svc = service(boom);
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the event', () => added().length === 1 && svc.isIdle());
    expect(payloadOf(added()[0]!)).toMatchObject({ reason: 'permanent-failure', error: 'refused for good', attempts: 1, target: 'action:boom' });
    expect(payloadOf(added()[0]!)).not.toHaveProperty('exitCode');
  });

  it('invalid configuration: the reason says so and the error is the actionable text of the entry', async () => {
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: bad', '      action: no-such-action', ''].join('\n'));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the event', () => added().length === 1 && svc.isIdle());
    const [entry] = listDlqEntries(configDir);
    expect(payloadOf(added()[0]!)).toMatchObject({ reason: 'invalid-configuration', entryId: entry!.id });
    expect(payloadOf(added()[0]!)['error']).toBe(entry!.lastError.slice(0, 500));
  });

  it('the error is capped at 500 characters', async () => {
    const { plugin: boom } = plugin('boom', () => ({ success: false, error: 'x'.repeat(3000), permanent: true }));
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: b', '      action: boom', ''].join('\n'));
    const svc = service(boom);
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the event', () => added().length === 1 && svc.isIdle());
    expect((payloadOf(added()[0]!)['error'] as string).length).toBe(500);
    expect(listDlqEntries(configDir)[0]!.lastError.length).toBe(3000);
  });

  it('a subscriber that was given a delivery of an event emitted by a client carries hops + 1, and the subscriber sees them in its envelope', async () => {
    const { plugin: sink, seen } = plugin('sink');
    await projectWith(YAML(failingCli('onFoo'), ['  queue.dlq.added:', '    - type: action', '      name: sink', '      action: sink']));
    const svc = service(sink);
    const push = await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the subscriber of the event to run', () => seen.length === 1 && svc.isIdle());
    expect(seen[0]!.meta).toMatchObject({ hops: 1, origin: 'queue', projectId, cwd: projectDir });
    expect(added()[0]!.causedBy).toEqual({ eventId: push.eventId, subscriberId: `${projectId}/f` });
  });

  it('an event emitted by an action chain keeps counting: hops of the failed dispatch + 1', async () => {
    const { plugin: sink, seen } = plugin('sink');
    const { plugin: boom } = plugin('boom', () => ({ success: false, error: 'no', permanent: true }));
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: wake', '      action: emit', '      with:', '        event: onB',
      '  onB:', '    - type: action', '      name: b', '      action: boom', '  queue.dlq.added:', '    - type: action', '      name: sink', '      action: sink', ''].join('\n'));
    const svc = service(sink, boom);
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the event', () => seen.length === 1 && svc.isIdle());
    // onFoo (0) -> emit -> onB (1) fails -> added (2)
    expect(seen[0]!.meta.hops).toBe(2);
    expect(payloadOf(added()[0]!)['event']).toBe('onB');
  });

  it('a subscriber on ">" receives the event with the reference only, never the base payload', async () => {
    const { plugin: sink, seen } = plugin('sink');
    await projectWith(YAML(failingCli('onFoo'), ["  '>':", '    - type: action', '      name: all', '      action: sink']));
    const svc = service(sink);
    await svc.commands.push({ event: 'onFoo', payload: { taskId: 'T-42', secret: 'S3CRET' }, cwd: projectDir });
    await waitFor('the wildcard subscriber to see the event', () => seen.some((e) => e.event === 'queue.dlq.added') && svc.isIdle());
    const envelope = seen.find((e) => e.event === 'queue.dlq.added')!;
    const text = JSON.stringify(envelope.payload);
    expect(text).not.toContain('T-42');
    expect(text).not.toContain('S3CRET');
    expect((envelope.payload as Record<string, unknown>)['original']).toEqual({ $eventRef: expect.any(String) });
  });

  it('a cli subscriber on it reads a field of the base event through {{ payload.original.<field> }} (real child process, argv)', async () => {
    const out = join(projectDir, 'argv.json');
    const script = join(projectDir, 'write-argv.js');
    writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));");
    const command = `"${process.execPath}" "${script}" "${out}" {{ payload.original.taskId }} "{{ payload.original.title }}" {{ payload.reason }}`;
    await projectWith(YAML(failingCli('onTask.failed'), ['  queue.dlq.added:', '    - type: cli', '      name: show', `      command: ${JSON.stringify(command)}`]));
    const svc = service();
    await svc.commands.push({ event: 'onTask.failed', payload: { taskId: 'T-42', title: 'Two words' }, cwd: projectDir });
    await waitFor('the child process to write its arguments', () => existsSync(out) && svc.isIdle());
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['T-42', 'Two words', 'retries-exhausted']);
  });

  it('never for an entry whose base event is in the queue. namespace; a subscriber that always fails on it gives exactly one DLQ entry and no storm', async () => {
    await projectWith(YAML(failingCli('onFoo'), failingCli('queue.dlq.added', 'loop')));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('both failures in the DLQ', () => svc.isIdle() && listDlqEntries(configDir).length === 2);
    // give a hypothetical storm time to show: the daemon is idle, so nothing is in flight
    expect(svc.isIdle()).toBe(true);
    const entries = listDlqEntries(configDir);
    expect(entries.filter((e) => e.subscriberId === `${projectId}/loop`)).toHaveLength(1);
    expect(entries.find((e) => e.subscriberId === `${projectId}/loop`)!.event).toBe('queue.dlq.added');
    expect(added()).toHaveLength(1);
    expect(removed()).toEqual([]);
  });

  it('a chain onFoo -> emit onB -> fails -> added -> emit onB -> ... stops at the hop cap, with a diagnostic naming the entry', async () => {
    const { plugin: boom } = plugin('boom', () => ({ success: false, error: 'no', permanent: true }));
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: wake', '      action: emit', '      with:', '        event: onB',
      '  onB:', '    - type: action', '      name: b', '      action: boom',
      '  queue.dlq.added:', '    - type: action', '      name: again', '      action: emit', '      with:', '        event: onB', ''].join('\n'));
    const svc = service(boom);
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the chain to stop', () => svc.isIdle() && lines.mock.calls.some((call) => call[0].message.includes('loop guard: queue.dlq.added for DLQ entry')));

    // onFoo(0) -> onB(1) fails -> added(2) -> onB(3) fails -> added(4) -> onB(5) fails: its event would be hop 6
    expect(added()).toHaveLength(2);
    const capped = listDlqEntries(configDir).find((e) => e.event === 'onB' && e.meta.hops === 5)!;
    const line = lines.mock.calls.map((call) => call[0].message).find((message) => message.includes('loop guard: queue.dlq.added'))!;
    expect(line).toContain(capped.id);
    expect(line).toContain('cap 5');
    expect(line).toContain('Fix:');
    // the chain really ended: three onB failures, nothing in flight
    expect(listDlqEntries(configDir).filter((e) => e.event === 'onB')).toHaveLength(3);
  });

  it('a retry that fails again while the DLQ row already exists does not emit a second event (idempotent append)', async () => {
    await projectWith(YAML(failingCli('onFoo', 'f', ['      retries: 2'])));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the first failure', () => svc.isIdle() && wal().some((e) => e.status === 'failed'));
    const failed = wal().find((e) => e.status === 'failed')!;
    // A crash between dlq.append and the WAL update leaves exactly this: the row is there, the WAL entry is still 'failed'
    new DlqStore(join(configDir, 'dlq.ndjson')).append({ id: failed.id, event: failed.event, payload: failed.payload, meta: failed.meta, subscriberId: failed.subscriberId, attempts: 1, lastError: 'first move', movedAt: new Date().toISOString() });

    expect(await svc.commands.retry({ eventId: failed.id })).toEqual({ status: 'ok' });
    await waitFor('the retry to end', () => svc.isIdle() && wal().find((e) => e.id === failed.id)!.status === 'dlq');
    expect(listDlqEntries(configDir)).toHaveLength(1);
    expect(listDlqEntries(configDir)[0]!.attempts).toBe(2);
    expect(added()).toEqual([]);
  });

  it('an event that cannot be filed (no directory, no project) is said in the log and never thrown', async () => {
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    seedDlq([dlqEntry('orphan', {}, { cwd: undefined, projectId: undefined })]);
    expect(svc.commands['dlq-clear']({ id: 'orphan' })).toEqual({ cleared: 1 });
    await waitFor('the diagnostic', () => lines.mock.calls.length > 0 && svc.isIdle());
    const message = lines.mock.calls.map((call) => call[0].message).find((m) => m.includes('queue.dlq.removed'))!;
    expect(message).toContain('orphan');
    expect(message).toContain('rejected');
    expect(removed()).toEqual([]);
  });

  it('shutdown while a failing cli subscriber is in flight does not throw, and the entry still ends in the DLQ with its event', async () => {
    const slow = join(projectDir, 'slow-fail.js');
    // Fails only when the test releases it: it is certainly still running when the shutdown happens
    const gate = join(projectDir, 'release-slow');
    writeFileSync(slow, `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.exit(1); } }, 10);`);
    const command = `"${process.execPath}" "${slow}"`;
    await projectWith(['subscribers:', '  onFoo:', '    - type: cli', '      name: slow', `      command: ${JSON.stringify(command)}`, '      retries: 0', ''].join('\n'));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(() => svc.onShutdown()).not.toThrow();
    writeFileSync(gate, 'go');
    await waitFor('the entry and its event', () => svc.isIdle() && added().length === 1);
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });
});

describe('queue.dlq.removed', () => {
  it('evicted: the oldest entry leaves at the cap, its event says so (and the new one is added)', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    seedDlq(Array.from({ length: 1000 }, (_, i) => dlqEntry(`e${i}`)));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the eviction event', () => removed().length === 1 && added().length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)).toEqual({
      entryId: 'e0', eventId: 'evt-e0', event: 'onSeed', subscriberId: `${projectId}/old`, projectId, reason: 'evicted', original: { $eventRef: 'evt-e0' },
    });
    expect(listDlqEntries(configDir)).toHaveLength(1000);
    expect(listDlqEntries(configDir).some((e) => e.id === 'e0')).toBe(false);
  });

  it('an evicted entry whose base event is a queue. event gives no event', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    seedDlq(Array.from({ length: 1000 }, (_, i) => dlqEntry(`e${i}`, i === 0 ? { event: 'queue.dlq.added' } : {})));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the new entry', () => added().length === 1 && svc.isIdle());
    expect(listDlqEntries(configDir).some((e) => e.id === 'e0')).toBe(false);
    expect(removed()).toEqual([]);
  });

  it('clear of one entry: one event with the reason cleared, after the clear returned', async () => {
    const { plugin: sink, seen } = plugin('sink');
    await projectWith(['subscribers:', '  queue.dlq.removed:', '    - type: action', '      name: sink', '      action: sink', ''].join('\n'));
    seedDlq([dlqEntry('a'), dlqEntry('b')]);
    const svc = service(sink);
    const response = svc.commands['dlq-clear']({ id: 'a' });
    expect(response).toEqual({ cleared: 1 });
    await waitFor('the event', () => seen.length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)).toMatchObject({ entryId: 'a', reason: 'cleared', original: { $eventRef: 'evt-a' } });
    expect(listDlqEntries(configDir).map((e) => e.id)).toEqual(['b']);
    expect(seen[0]!.meta).toMatchObject({ origin: 'queue', projectId, cwd: projectDir });
    // unknown id: nothing removed, nothing emitted
    expect(svc.commands['dlq-clear']({ id: 'nope' })).toEqual({ cleared: 0 });
    expect(removed()).toHaveLength(1);
  });

  it('clear of all (more than one batch of 10): one event per entry, each entry once', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    seedDlq(Array.from({ length: 27 }, (_, i) => dlqEntry(`c${i}`)));
    const svc = service();
    expect(svc.commands['dlq-clear']({})).toEqual({ cleared: 27 });
    // the daemon does not report idle while the batch is being emitted
    await waitFor('the 27 events', () => removed().length === 27 && svc.isIdle());
    const ids = removed().map((entry) => payloadOf(entry)['entryId']);
    expect(new Set(ids).size).toBe(27);
    expect(removed().every((entry) => payloadOf(entry)['reason'] === 'cleared')).toBe(true);
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('a legacy entry without meta.eventId gives an event without eventId and a null reference', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    seedDlq([dlqEntry('old', {}, { eventId: undefined })]);
    const svc = service();
    svc.commands['dlq-clear']({ id: 'old' });
    await waitFor('the event', () => removed().length === 1 && svc.isIdle());
    const payload = payloadOf(removed()[0]!);
    expect(payload).not.toHaveProperty('eventId');
    expect(payload['original']).toEqual({ $eventRef: null });
    expect(payload['entryId']).toBe('old');
  });

  it('a cleared entry whose base event is a queue. event gives no event', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    seedDlq([dlqEntry('q', { event: 'queue.dlq.removed' }), dlqEntry('n')]);
    const svc = service();
    expect(svc.commands['dlq-clear']({})).toEqual({ cleared: 2 });
    await waitFor('the event of the normal entry', () => removed().length === 1 && svc.isIdle());
    expect(payloadOf(removed()[0]!)['entryId']).toBe('n');
  });

  it('replay: removed(replayed) once the dispatch started, then added again with the same entryId when it fails again', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the first move', () => added().length === 1 && svc.isIdle());
    const [first] = listDlqEntries(configDir);

    expect(await svc.commands['dlq-replay']({ id: first!.id })).toEqual({ status: 'ok' });
    await waitFor('the second move', () => added().length === 2 && svc.isIdle());

    expect(removed()).toHaveLength(1);
    expect(payloadOf(removed()[0]!)).toMatchObject({ entryId: first!.id, reason: 'replayed', eventId: first!.meta.eventId });
    expect(added().map((entry) => payloadOf(entry)['entryId'])).toEqual([first!.id, first!.id]);
    // removed comes between the two added events
    const order = ['queue.dlq.added', 'queue.dlq.removed'].flatMap((name) => emitted(name).map((entry) => ({ name, ts: entry.ts })));
    order.sort((a, b) => a.ts.localeCompare(b.ts));
    expect(order.map((o) => o.name)).toEqual(['queue.dlq.added', 'queue.dlq.removed', 'queue.dlq.added']);
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });

  it('replay of an unknown id emits nothing', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    const svc = service();
    expect(await svc.commands['dlq-replay']({ id: 'nope' })).toEqual({ status: 'not-found' });
    expect(removed()).toEqual([]);
  });

  // R2a item 3: these two tests used to pin the defect (the row left the DLQ and the daemon answered ok although nothing ran). They are replaced, not weakened:
  // the replay is refused with an error and the DLQ is left alone (full coverage in dlqReplay.test.ts).
  it('replay when the subscriber was renamed: answers an error that names the subscriber, the row stays in the DLQ and no removed event is emitted', async () => {
    await projectWith(YAML(failingCli('onSeed', 'renamed')));
    seedDlq([dlqEntry('r1', { subscriberId: `${projectId}/old` })]);
    const svc = service();
    const response = await svc.commands['dlq-replay']({ id: 'r1' });
    expect(response.status).toBe('error');
    expect(response.message).toContain(`${projectId}/old`);
    expect(response.message).toContain('Fix:');
    expect(listDlqEntries(configDir).map((e) => e.id)).toEqual(['r1']);
    expect(wal().some((e) => e.id === 'r1')).toBe(false);
    expect(svc.isIdle()).toBe(true);
    expect(removed()).toEqual([]);
  });

  it('replay when the configuration fails to load: answers an error, the row stays in the DLQ and nothing is emitted', async () => {
    await projectWith('subscribers: [unclosed\n');
    seedDlq([dlqEntry('r2')]);
    const svc = service();
    const response = await svc.commands['dlq-replay']({ id: 'r2' });
    expect(response.status).toBe('error');
    expect(response.message).toContain('r2');
    expect(response.message).toContain('Fix:');
    expect(wal().some((e) => e.id === 'r2')).toBe(false);
    expect(listDlqEntries(configDir).map((e) => e.id)).toEqual(['r2']);
    expect(removed()).toEqual([]);
  });
});

describe('catalog', () => {
  it('the daemon declares both events under the source queue at start, whatever the wire says about that source', () => {
    const svc = service();
    svc.onStart();
    const catalog = readCatalog(configDir);
    expect(catalog.problems).toEqual([]);
    const source = catalog.sources.find((s) => s.source === 'queue')!;
    expect(source.events.map((e) => e.name)).toEqual(['queue.dlq.added', 'queue.dlq.removed']);
    expect(source.events[0]!.description).toContain('Emitted by the daemon for every delivery that enters the dead-letter queue');
    expect(JSON.stringify(source.events[0]!.schema)).toContain('$eventRef');
    // the wire still cannot claim the source
    expect(svc.commands['register-events']({ source: 'queue', events: [{ name: 'x.y', description: 'd' }] }).status).toBe('rejected');
  });

  it('a daemon that starts again replaces the file (no duplicate)', () => {
    service().onStart();
    mkdirSync(join(configDir, 'events'), { recursive: true });
    service().onStart();
    expect(readCatalog(configDir).sources.filter((s) => s.source === 'queue')).toHaveLength(1);
  });
});
