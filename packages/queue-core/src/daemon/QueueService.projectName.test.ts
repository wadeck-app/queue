import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createQueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import type { EventEnvelope } from '../types.js';
import { waitFor } from '../waitFor.testUtil.js';

let configDir: string;
let registryDir: string;
let parentDir: string;
let childDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-pname-config-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-pname-registry-'));
  parentDir = mkdtempSync(join(tmpdir(), 'queue-pname-parent-'));
  childDir = mkdtempSync(join(tmpdir(), 'queue-pname-child-'));
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [configDir, registryDir, parentDir, childDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe('the attribution of an event emitted for a to-children descendant', () => {
  it('projectName follows projectId (the descendant), not the working directory of the emitter', async () => {
    // a legacy .queue folder in the emitter's directory is what made the name come from the cwd
    mkdirSync(join(parentDir, '.queue'));
    const parent = await addProject(registryDir, { name: 'parent', path: parentDir });
    const child = await addProject(registryDir, { name: 'child', path: childDir, parent: 'parent' });
    writeFileSync(join(projectToolDir(registryDir, parent.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), 'subscribers: {}\n');
    writeFileSync(join(projectToolDir(registryDir, child.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), [
      'subscribers:',
      '  onFoo:',
      '    - { type: action, name: relay, action: emit, with: { event: agent.message } }',
      '  agent.message:',
      '    - { type: action, name: sink, action: sink }',
      '',
    ].join('\n'));
    const seen: EventEnvelope[] = [];
    const sink: ActionPlugin = { name: 'sink', validate: () => undefined, run: (_c, envelope) => { seen.push(envelope); return Promise.resolve({ success: true }); } };
    const service = createQueueService(configDir, { registryDir, actions: createActionRegistry([sink]) });

    await service.commands.push({ event: 'onFoo', payload: {}, cwd: parentDir, project: parent.id, direction: ['to-children'], protocol: '1.4.0' } as never);
    await waitFor('the emitted event to reach its subscriber', () => seen.length === 1 && service.isIdle());

    expect(seen[0]!.meta.projectId).toBe(child.id);
    expect(seen[0]!.meta.projectName).toBe('child');
  });
});
