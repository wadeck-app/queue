import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { DlqStore, type DlqEntry } from '../storage/DlqStore.js';
import { HistoryReader, type HistoryEntry } from '../storage/HistoryReader.js';
import { clearDlqEntriesReturning, listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';

// dlq-replay: the subscriber is resolved BEFORE the row is touched. A replay that cannot run answers an error that says what to fix and leaves the DLQ as it was.

let configDir: string;
let projectDir: string;
let registryDir: string;
let projectId: string;
let ymlPath: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dlqreplay-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dlqreplay-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-dlqreplay-registry-'));
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
const removed = (): HistoryEntry[] => new HistoryReader(join(configDir, 'history')).read({ event: 'queue.dlq.removed' });

async function projectWith(yml: string): Promise<void> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  ymlPath = join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml');
  writeFileSync(ymlPath, yml);
  projectId = project.id;
}

const service = (): QueueService => createQueueService(configDir, { registryDir, actions: createActionRegistry([]) });

/** A cli subscriber `name` for onSeed that writes a marker file when it runs (so a test can tell whether it ran). */
function markerCli(name: string, marker: string, exitCode = 0): string {
  const script = join(projectDir, `${name}.js`);
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(${exitCode});`);
  return ['subscribers:', '  onSeed:', '    - type: cli', `      name: ${name}`, `      command: ${JSON.stringify(`"${process.execPath}" "${script}"`)}`, '      retries: 0', ''].join('\n');
}

function dlqRow(id: string, overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id,
    event: 'onSeed',
    payload: { secret: `payload-of-${id}` },
    meta: { cwd: projectDir, projectId, eventId: `evt-${id}` },
    subscriberId: `${projectId}/ok`,
    attempts: 3,
    lastError: 'seeded',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

function seedRowAndWal(id: string, rowOverrides: Partial<DlqEntry> = {}): DlqEntry {
  const row = dlqRow(id, rowOverrides);
  new DlqStore(join(configDir, 'dlq.ndjson')).append(row);
  new Wal(join(configDir, 'wal.ndjson')).append({ id, timestamp: '2026-11-06T10:00:00.000Z', event: row.event, payload: row.payload, meta: row.meta, subscriberId: row.subscriberId, status: 'dlq', attempts: 3, lastError: 'seeded' });
  return row;
}

describe('a replay that cannot run answers an error and leaves everything as it was', () => {
  it('the configuration fails to load: status error, a message that names the entry and says what to fix, the row stays, nothing in the WAL changes, no removed event', async () => {
    await projectWith('subscribers: [unclosed\n');
    seedRowAndWal('r2');
    const svc = service();
    const lines = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const before = wal();
    const response = await svc.commands['dlq-replay']({ id: 'r2' });

    expect(response.status).toBe('error');
    expect(response.message).toContain('r2');
    expect(response.message).toContain('subscribers.yml');
    expect(response.message).toContain('Fix:');
    expect(response.message).toContain('still in the dead-letter queue');
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['r2']);
    expect(wal()).toEqual(before);
    expect(lines.mock.calls.some((call) => call[0].source === 'QueueDaemon.dlq-replay')).toBe(true);
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(removed()).toEqual([]);
    expect(svc.isIdle()).toBe(true);
  });

  it('the subscriber was renamed: status error naming the subscriber, the row stays, the WAL is untouched', async () => {
    const marker = join(projectDir, 'ran.txt');
    await projectWith(markerCli('renamed', marker));
    seedRowAndWal('r1', { subscriberId: `${projectId}/old` });
    const svc = service();
    const before = wal();
    const response = await svc.commands['dlq-replay']({ id: 'r1' });

    expect(response.status).toBe('error');
    expect(response.message).toContain(`${projectId}/old`);
    expect(response.message).toContain('Fix:');
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['r1']);
    expect(wal()).toEqual(before);
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(existsSync(marker)).toBe(false);
    expect(removed()).toEqual([]);
  });

  it('after the configuration is fixed the same replay works: the entry was never lost', async () => {
    const marker = join(projectDir, 'ran.txt');
    await projectWith('subscribers: [unclosed\n');
    seedRowAndWal('r3');
    const svc = service();
    expect((await svc.commands['dlq-replay']({ id: 'r3' })).status).toBe('error');
    writeFileSync(ymlPath, markerCli('ok', marker));
    expect(await svc.commands['dlq-replay']({ id: 'r3' })).toEqual({ status: 'ok' });
    await waitFor('the subscriber to run and the daemon to be idle', () => existsSync(marker) && svc.isIdle());
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('a clear that removes the row between the read and the removal: nothing is dispatched, the WAL entry that was re-created is rolled back, status error', async () => {
    const marker = join(projectDir, 'ran.txt');
    await projectWith(markerCli('ok', marker));
    seedRowAndWal('r4');
    const svc = service();
    // the concurrent clear lands after the replay validated and before it removes the row
    const original = DlqStore.prototype.removeEntries;
    vi.spyOn(DlqStore.prototype, 'removeEntries').mockImplementationOnce(function (this: DlqStore, ...args: Parameters<DlqStore['removeEntries']>) {
      clearDlqEntriesReturning(configDir);
      return original.apply(this, args);
    });
    const response = await svc.commands['dlq-replay']({ id: 'r4' });

    expect(response.status).toBe('error');
    expect(response.message).toContain('r4');
    expect(response.message).toContain('removed');
    await waitFor('nothing left in flight (no dispatch, no announcement)', () => svc.isIdle());
    expect(existsSync(marker)).toBe(false);
    expect(wal().some((entry) => entry.id === 'r4')).toBe(false);
    expect(svc.isIdle()).toBe(true);
  });

  it('an unknown id is still not-found', async () => {
    await projectWith(markerCli('ok', join(projectDir, 'ran.txt')));
    expect(await service().commands['dlq-replay']({ id: 'nope' })).toEqual({ status: 'not-found' });
  });
});

describe('a replay that can run', () => {
  it('re-creates the WAL entry under the same id: exactly ONE WAL entry carries the id (retry and give-up find the right one)', async () => {
    const marker = join(projectDir, 'ran.txt');
    await projectWith(markerCli('ok', marker, 3));
    seedRowAndWal('r5');
    expect(wal().filter((entry) => entry.id === 'r5')).toHaveLength(1);
    const svc = service();
    expect(await svc.commands['dlq-replay']({ id: 'r5' })).toEqual({ status: 'ok' });
    // at every moment of the replay and after it fails again into the DLQ, the id is in the WAL once
    expect(wal().filter((entry) => entry.id === 'r5')).toHaveLength(1);
    await waitFor('the replay to fail again into the DLQ', () => svc.isIdle() && listDlqEntries(configDir).length === 1 && wal().find((entry) => entry.id === 'r5')?.status === 'dlq');
    expect(wal().filter((entry) => entry.id === 'r5')).toHaveLength(1);
    expect(existsSync(marker)).toBe(true);
  });

  it('removed(replayed) is emitted once the dispatch started', async () => {
    await projectWith(markerCli('ok', join(projectDir, 'ran.txt')));
    seedRowAndWal('r6');
    const svc = service();
    await svc.commands['dlq-replay']({ id: 'r6' });
    await waitFor('the event', () => removed().length === 1 && svc.isIdle());
    expect((removed()[0]!.payload as Record<string, unknown>)).toMatchObject({ entryId: 'r6', reason: 'replayed' });
  });
});
