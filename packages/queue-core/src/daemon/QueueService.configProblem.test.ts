import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { ConfigLoader } from '../ConfigLoader.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { waitFor } from '../waitFor.testUtil.js';
import { listDlqEntries } from '../operations.js';

// A subscriber that cannot run (unknown action, a plugin that refuses its `with`, a plugin whose validate throws) must not look healthy until an event fires:
// it is said once per daemon run in the log, and listed with a `problem`.
let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-cfgproblem-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-cfgproblem-project-'));
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const THROWING: ActionPlugin = {
  name: 'fragile',
  validate: () => { throw new Error('kaboom in validate'); },
  run: () => Promise.resolve({ success: true }),
};

const FILE = [
  'subscribers:',
  '  onFoo:',
  '    - { type: action, name: ghost, action: not-installed }',
  '    - { type: action, name: shaky, action: fragile }',
  '    - { type: cli, name: fine, command: echo hi }',
  '',
].join('\n');

function logMessages(): string[] {
  const day = new Date().toISOString().slice(0, 10);
  return readFileSync(join(configDir, 'logs', `${day}.ndjson`), 'utf-8').trim().split('\n').map((line) => String((JSON.parse(line) as Record<string, unknown>)['message']));
}

describe('ConfigLoader: a plugin whose validate throws', () => {
  it('becomes the configProblem of that subscriber (plugin name and message), and the file still loads', () => {
    writeFileSync(join(configDir, 'subscribers.yml'), FILE);
    const loaded = new ConfigLoader(configDir, { actions: createActionRegistry([THROWING]) }).load(undefined);
    const byName = Object.fromEntries(loaded.get('onFoo')!.map((sub) => [sub.name, sub]));
    expect(byName['shaky']!.configProblem).toContain("validate() of action 'fragile' threw: kaboom in validate");
    expect(byName['shaky']!.configProblem).toContain('Fix:');
    expect(byName['ghost']!.configProblem).toMatch(/unknown action/);
    expect(byName['fine']!.configProblem).toBeUndefined();
  });
});

describe('the daemon and a subscriber with a configProblem', () => {
  it('a push still works and only the broken subscribers fail, for good, to the DLQ', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), FILE);
    const service = createQueueService(configDir, { actions: createActionRegistry([THROWING]) });

    const response = await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the DLQ rows', () => service.isIdle() && listDlqEntries(configDir).length === 2);

    expect(response).toMatchObject({ status: 'queued', subscriberCount: 3 });
    expect(listDlqEntries(configDir).map((row) => row.subscriberId).sort()).toEqual(['ghost', 'shaky']);
  });

  it('says every configProblem in the log once per daemon run, naming the file, the event, the subscriber and the fix', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), FILE);
    const service = createQueueService(configDir, { actions: createActionRegistry([THROWING]) });

    for (let i = 0; i < 3; i++) {
      await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    }
    await waitFor('the dispatches', () => service.isIdle());

    const said = logMessages().filter((message) => message.includes('cannot run'));
    expect(said).toHaveLength(2);
    const ghost = said.find((message) => message.includes('ghost'))!;
    expect(ghost).toContain('subscribers.yml');
    expect(ghost).toContain('onFoo');
    expect(ghost).toContain('Fix:');
    expect(said.find((message) => message.includes('shaky'))).toContain('kaboom in validate');
  });

  it('says them at start too, before any event fires', () => {
    writeFileSync(join(configDir, 'subscribers.yml'), FILE);
    const service = createQueueService(configDir, { actions: createActionRegistry([THROWING]) });

    service.onStart();

    expect(logMessages().filter((message) => message.includes('cannot run'))).toHaveLength(2);
  });

  it('list-subscribers carries a problem field on the broken ones and none on the others', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), FILE);
    const service = createQueueService(configDir, { actions: createActionRegistry([THROWING]) });

    const { subscribers } = await service.commands['list-subscribers']({ cwd: projectDir });

    const problems = Object.fromEntries(subscribers.map((sub) => [sub.name, sub.problem]));
    expect(problems['ghost']).toMatch(/unknown action/);
    expect(problems['shaky']).toMatch(/kaboom in validate/);
    expect(problems['fine']).toBeUndefined();
    expect(subscribers.find((sub) => sub.name === 'fine')).not.toHaveProperty('problem');
  });
});
