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

// queue.dlq.added is never lost: when the emit does not succeed the row is still written, marked announce 'pending', and the daemon emits it later.

let configDir: string;
let projectDir: string;
let registryDir: string;
let projectId: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dlqannounce-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dlqannounce-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-dlqannounce-registry-'));
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
const added = (): HistoryEntry[] => history().read({ event: 'queue.dlq.added' }).reverse();
const payloadOf = (entry: HistoryEntry): Record<string, unknown> => entry.payload as Record<string, unknown>;

let ymlPath = '';

async function projectWith(yml: string): Promise<void> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  ymlPath = join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml');
  writeFileSync(ymlPath, yml);
  projectId = project.id;
}

function service(...plugins: ActionPlugin[]): QueueService {
  return createQueueService(configDir, { registryDir, actions: createActionRegistry(plugins) });
}

/** A cli subscriber that fails with exit code 3 after `delayMs`: the time to break the configuration between the push and the move to the DLQ. */
function failingCli(event: string, delayMs = 0): string[] {
  const script = join(projectDir, 'fail.js');
  writeFileSync(script, `setTimeout(() => process.exit(3), ${delayMs});`);
  const command = `"${process.execPath}" "${script}"`;
  return [`  ${event}:`, '    - type: cli', '      name: f', `      command: ${JSON.stringify(command)}`, '      retries: 0'];
}

const YAML = (...blocks: string[][]): string => ['subscribers:', ...blocks.flat(), ''].join('\n');

function dlqRow(id: string, overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id,
    event: 'onSeed',
    payload: { seeded: id },
    meta: { cwd: projectDir, projectId, eventId: `evt-${id}` },
    subscriberId: `${projectId}/old`,
    attempts: 1,
    lastError: 'seeded',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('an invalid subscribers.yml at the moment of the move', () => {
  it('the row is written with the pending mark and NO event exists; after the file is fixed, the next successful push emits it exactly once and clears the mark', async () => {
    await projectWith(YAML(failingCli('onFoo', 500)));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    await svc.commands.push({ event: 'onFoo', payload: { taskId: 'T-1' }, cwd: projectDir });
    // the configuration breaks while the subscriber runs
    writeFileSync(ymlPath, 'subscribers: [unclosed\n');
    await waitFor('the row', () => listDlqEntries(configDir).length === 1 && svc.isIdle());

    const [row] = listDlqEntries(configDir);
    expect(row).toMatchObject({ announce: 'pending', announceInfo: { reason: 'retries-exhausted', exitCode: 3 } });
    expect(added()).toEqual([]);
    expect(wal().find((entry) => entry.id === row!.id)!.status).toBe('dlq');
    // loud: the log names the entry and why
    expect(lines.mock.calls.some((call) => call[0].message.includes(row!.id) && call[0].message.includes('was not emitted (aborted)'))).toBe(true);

    // fixed; the next successful push (here: an event nobody listens to) is the trigger
    writeFileSync(ymlPath, YAML(failingCli('onFoo')));
    expect((await svc.commands.push({ event: 'onOther', payload: {}, cwd: projectDir })).status).toBe('queued');
    await waitFor('the late event', () => added().length === 1 && svc.isIdle());
    expect(payloadOf(added()[0]!)).toMatchObject({ entryId: row!.id, reason: 'retries-exhausted', exitCode: 3, event: 'onFoo' });
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announce');
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announceInfo');

    // exactly once: more pushes and a restart add nothing
    await svc.commands.push({ event: 'onOther', payload: {}, cwd: projectDir });
    const restarted = service();
    restarted.onStart();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(added()).toHaveLength(1);
  });

  it('a restart emits it: onStart finds the pending row once the file is valid', async () => {
    await projectWith(YAML(failingCli('onFoo', 500)));
    const first = service();
    await first.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    writeFileSync(ymlPath, 'subscribers: [unclosed\n');
    await waitFor('the row', () => listDlqEntries(configDir).length === 1 && first.isIdle());
    expect(listDlqEntries(configDir)[0]!.announce).toBe('pending');

    writeFileSync(ymlPath, YAML(failingCli('onFoo')));
    const second = service();
    second.onStart();
    // the start scan is in flight: the daemon does not report idle meanwhile
    await waitFor('the event', () => added().length === 1 && second.isIdle());
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announce');
    expect(payloadOf(added()[0]!)['entryId']).toBe(listDlqEntries(configDir)[0]!.id);
  });

  it('a start with the file still invalid emits nothing, keeps the mark and says so in the log (no loss, no silence)', async () => {
    await projectWith('subscribers: [unclosed\n');
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqRow('late', { announce: 'pending', announceInfo: { reason: 'permanent-failure', target: 'action:x' } }));
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    svc.onStart();
    await waitFor('the diagnostic', () => lines.mock.calls.some((call) => call[0].message.includes('late') && call[0].message.includes('was not emitted')) && svc.isIdle());
    expect(added()).toEqual([]);
    expect(listDlqEntries(configDir)[0]).toMatchObject({ announce: 'pending' });
  });

  it('the reason, exit code and target recorded with the mark are the ones of the late event', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqRow('late', { announce: 'pending', announceInfo: { reason: 'permanent-failure', exitCode: 9, target: 'node x.js' } }));
    const svc = service();
    svc.onStart();
    await waitFor('the event', () => added().length === 1 && svc.isIdle());
    expect(payloadOf(added()[0]!)).toMatchObject({ entryId: 'late', reason: 'permanent-failure', exitCode: 9, target: 'node x.js', eventId: 'evt-late' });
  });
});

describe('what is not emitted on purpose', () => {
  it('the hop cap: the row is marked skipped (never retried), the log names the entry, and a later push or restart does not emit it', async () => {
    const boom: ActionPlugin = { name: 'boom', validate: () => undefined, run: () => Promise.resolve({ success: false, error: 'no', permanent: true }) };
    await projectWith(['subscribers:', '  onFoo:', '    - type: action', '      name: wake', '      action: emit', '      with:', '        event: onB',
      '  onB:', '    - type: action', '      name: b', '      action: boom',
      '  queue.dlq.added:', '    - type: action', '      name: again', '      action: emit', '      with:', '        event: onB', ''].join('\n'));
    const svc = service(boom);
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the chain to stop', () => svc.isIdle() && lines.mock.calls.some((call) => call[0].message.includes('loop guard: queue.dlq.added for DLQ entry')));
    const capped = listDlqEntries(configDir).find((row) => row.event === 'onB' && row.meta.hops === 5)!;
    expect(capped.announce).toBe('skipped');
    expect(capped.announceInfo).toMatchObject({ reason: 'permanent-failure' });
    expect(lines.mock.calls.map((call) => call[0].message).find((message) => message.includes('loop guard'))).toContain(capped.id);

    const before = added().length;
    await svc.commands.push({ event: 'onOther', payload: {}, cwd: projectDir });
    const restarted = service(boom);
    restarted.onStart();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(added()).toHaveLength(before);
    expect(listDlqEntries(configDir).find((row) => row.id === capped.id)!.announce).toBe('skipped');
  });

  it('an entry whose base event is a queue.* event is not announced and carries no mark', async () => {
    await projectWith(YAML(failingCli('queue.dlq.added'), failingCli('onFoo')));
    const svc = service();
    await svc.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('both rows', () => svc.isIdle() && listDlqEntries(configDir).length === 2);
    const loop = listDlqEntries(configDir).find((row) => row.event === 'queue.dlq.added')!;
    expect(loop).not.toHaveProperty('announce');
  });
});

describe('the mark survives a crash between the emit and the write', () => {
  it('emit done, row never written: the event exists once, the retried move writes ONE row, and the late scan does not add a third event', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    const append = vi.spyOn(DlqStore.prototype, 'append').mockImplementationOnce(() => { throw new Error('simulated crash'); });
    const first = service();
    const lines = vi.spyOn(first.eventLogger, 'logDiagnostic');
    await first.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await waitFor('the crash', () => lines.mock.calls.some((call) => call[0].message.includes('simulated crash')));
    expect(added()).toHaveLength(1);
    expect(listDlqEntries(configDir)).toEqual([]);
    append.mockRestore();

    const stranded = wal().find((entry) => entry.status === 'failed')!;
    const second = service();
    second.onStart();
    await second.commands.retry({ eventId: stranded.id });
    await waitFor('the row', () => second.isIdle() && listDlqEntries(configDir).length === 1);
    expect(added().length).toBeGreaterThanOrEqual(1);
    expect(listDlqEntries(configDir)).toHaveLength(1);
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announce');
  });

  it('emit done, mark not cleared yet (crash): the next scan emits again, a duplicate and never a loss, then the mark is gone', async () => {
    await projectWith(YAML(failingCli('onFoo')));
    // a late emit whose mark could not be cleared
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqRow('dup', { announce: 'pending', announceInfo: { reason: 'retries-exhausted' } }));
    const crash = vi.spyOn(DlqStore.prototype, 'setAnnounce').mockImplementationOnce(() => { throw new Error('simulated crash before the mark is cleared'); });
    const first = service();
    const lines = vi.spyOn(first.eventLogger, 'logDiagnostic');
    first.onStart();
    await waitFor('the crash to be reported', () => lines.mock.calls.some((call) => call[0].message.includes('simulated crash')) && first.isIdle());
    expect(added()).toHaveLength(1);
    expect(listDlqEntries(configDir)[0]!.announce).toBe('pending');
    crash.mockRestore();

    const second = service();
    second.onStart();
    await waitFor('the second emit', () => added().length === 2 && second.isIdle());
    expect(listDlqEntries(configDir)[0]).not.toHaveProperty('announce');
  });
});
