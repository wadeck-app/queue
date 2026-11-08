import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin, ActionResult } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { listDlqEntries } from '../operations.js';
import { ConfigLoader } from '../ConfigLoader.js';
import { waitFor } from '../waitFor.testUtil.js';

// A subscriber name is unique within one event key of a file, not across the keys: `onA` and `*` may both hold a subscriber called notify.
// The id of such subscribers is qualified with the event key, so a WAL entry, a DLQ row and a retry each point at exactly one of them.
let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-dupnames-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-dupnames-project-'));
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const TWO_NOTIFY = [
  'subscribers:',
  '  onA:',
  '    - { type: action, name: notify, action: tagged, retries: 3, with: { tag: first } }',
  '  "*":',
  '    - { type: action, name: notify, action: tagged, retries: 3, with: { tag: second } }',
  '',
].join('\n');

/** Records the tag of every run; `behave(tag, callIndexOfThatTag)` decides the outcome. */
function taggedPlugin(behave: (tag: string, nth: number) => ActionResult = () => ({ success: true })): { plugin: ActionPlugin; runs: string[] } {
  const runs: string[] = [];
  // Counted apart from `runs`, which a test empties
  const calls = new Map<string, number>();
  const plugin: ActionPlugin = {
    name: 'tagged',
    validate: () => undefined,
    run: (config) => {
      const tag = String(config['tag']);
      runs.push(tag);
      calls.set(tag, (calls.get(tag) ?? 0) + 1);
      return Promise.resolve(behave(tag, calls.get(tag)!));
    },
  };
  return { plugin, runs };
}

const walEntries = (): WalEntry[] => new Wal(join(configDir, 'wal.ndjson')).readAll();

describe('two subscribers with the same name under different event keys of one file', () => {
  it('both deliver exactly once, each under its own WAL entry, nothing stays pending and the daemon idles', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), TWO_NOTIFY);
    const { plugin, runs } = taggedPlugin();
    const service = createQueueService(configDir, { actions: createActionRegistry([plugin]) });

    const response = await service.commands.push({ event: 'onA', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the dispatches to finish', () => service.isIdle());

    expect(response).toMatchObject({ status: 'queued', subscriberCount: 2 });
    expect(runs.slice().sort()).toEqual(['first', 'second']);
    const entries = walEntries();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.subscriberId)).size).toBe(2);
    expect(entries.map((entry) => entry.status)).toEqual(['acked', 'acked']);
    expect(service.isIdle()).toBe(true);
  });

  it('a delivered pair leaves nothing for onStart to reschedule', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), TWO_NOTIFY);
    const { plugin } = taggedPlugin();
    const service = createQueueService(configDir, { actions: createActionRegistry([plugin]) });

    await service.commands.push({ event: 'onA', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the dispatches to finish', () => service.isIdle());
    service.onStart();

    expect(RetryScheduler.scheduleRetry).not.toHaveBeenCalled();
  });

  it('queue retry re-runs the subscriber the WAL entry was written for, not the first one with the same name', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), TWO_NOTIFY);
    // only the 'second' tag fails, once
    const { plugin, runs } = taggedPlugin((tag, nth) => (tag === 'second' && nth === 1 ? { success: false, error: 'flaky' } : { success: true }));
    const service = createQueueService(configDir, { actions: createActionRegistry([plugin]) });

    await service.commands.push({ event: 'onA', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the failed delivery to be recorded', () => service.isIdle() && walEntries().some((entry) => entry.status === 'failed'));
    const failed = walEntries().find((entry) => entry.status === 'failed')!;
    runs.length = 0;

    const answer = await service.commands.retry({ eventId: failed.id } as never);
    await waitFor('the retry to finish', () => service.isIdle() && walEntries().every((entry) => entry.status === 'acked'));

    expect(answer).toEqual({ status: 'ok' });
    expect(runs).toEqual(['second']);
  });

  it('dlq-replay re-runs the subscriber the DLQ row was written for', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), TWO_NOTIFY);
    const { plugin, runs } = taggedPlugin((tag, nth) => (tag === 'second' && nth === 1 ? { success: false, permanent: true, error: 'refused' } : { success: true }));
    const service = createQueueService(configDir, { actions: createActionRegistry([plugin]) });

    await service.commands.push({ event: 'onA', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the row to reach the DLQ', () => service.isIdle() && listDlqEntries(configDir).length === 1);
    const [row] = listDlqEntries(configDir);
    runs.length = 0;

    const answer = await service.commands['dlq-replay']({ id: row!.id });
    await waitFor('the replay to finish', () => service.isIdle() && walEntries().every((entry) => entry.status === 'acked'));

    expect(answer).toEqual({ status: 'ok' });
    expect(runs).toEqual(['second']);
  });
});

describe('ConfigLoader: the id of a subscriber whose name is used under several event keys', () => {
  it('keeps the plain id of a name used once, and qualifies the id of every holder of a repeated name with its event key', () => {
    writeFileSync(join(configDir, 'subscribers.yml'), [
      'subscribers:',
      '  onA:',
      '    - { type: action, name: notify, action: tagged }',
      '    - { type: action, name: solo, action: tagged }',
      '  "*":',
      '    - { type: action, name: notify, action: tagged }',
      '',
    ].join('\n'));
    const loaded = new ConfigLoader(configDir, { actions: createActionRegistry([taggedPlugin().plugin]) }).load(undefined);

    expect(loaded.get('onA')!.map((sub) => [sub.name, sub.subscriberId])).toEqual([['notify', 'notify@onA'], ['solo', 'solo']]);
    expect(loaded.get('*')!.map((sub) => [sub.name, sub.subscriberId])).toEqual([['notify', 'notify@*']]);
  });

  it('still refuses the same name twice under one event key', () => {
    writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers:\n  onA:\n    - { type: cli, name: dup, command: echo }\n    - { type: cli, name: dup, command: echo }\n');
    expect(() => new ConfigLoader(configDir).load(undefined)).toThrow(/Duplicate subscriber name 'dup' on event 'onA'/);
  });
});
