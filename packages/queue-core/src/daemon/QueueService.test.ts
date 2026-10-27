import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { readCatalog } from '../catalog/EventCatalog.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { waitFor } from '../waitFor.testUtil.js';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { isRecord } from '../isRecord.js';
import { listDlqEntries } from '../operations.js';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-service-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-service-project-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Registers `projectDir` in a new registry whose project holds this subscribers.yml in its config folder; returns the registry folder and the project id. */
async function registerProjectWithSubscribers(yml: string): Promise<{ registryDir: string; projectId: string }> {
  const registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
  return { registryDir, projectId: project.id };
}

describe('createQueueService', () => {
  it('starts idle with an empty queue, and status reports it', () => {
    const service = createQueueService(configDir);
    expect(service.isIdle()).toBe(true);
    expect(service.commands.status()).toMatchObject({ pendingCount: 0, dlqCount: 0, daemonRunning: true, pid: process.pid });
  });

  it('tells its host about activity when a push arrives, so the host can cancel its idle countdown', async () => {
    const onActivity = vi.fn();
    const service = createQueueService(configDir, { onActivity });
    await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it('an event nobody subscribes to is queued with zero subscribers and the service is idle again afterwards', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: { a: 1 }, cwd: projectDir });
    expect(response).toMatchObject({ status: 'queued', subscriberCount: 0 });
    expect(service.isIdle()).toBe(true);
  });

  it('onStart and onShutdown handle an empty WAL without throwing', () => {
    const service = createQueueService(configDir);
    expect(() => service.onStart()).not.toThrow();
    expect(() => service.onShutdown()).not.toThrow();
  });

  it('exposes the event logger so the host can write its own diagnostics next to the service ones', () => {
    const service = createQueueService(configDir);
    expect(() => service.eventLogger.logDiagnostic({ source: 'test', message: 'hello' })).not.toThrow();
  });
});

describe('push protocol version (SemVer, see @wadeck-app/queue-sdk/protocol)', () => {
  const historyFiles = (): string[] => {
    try {
      return readdirSync(join(configDir, 'history'));
    } catch {
      return [];
    }
  };

  it('accepts a push without protocol: every client that exists today speaks 1.0.0', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    expect(response.status).toBe('queued');
  });

  it.each(['1.0.0', '1.7.2'])('accepts protocol %s', async (protocol) => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir, protocol });
    expect(response.status).toBe('queued');
  });

  it('rejects a protocol MAJOR it does not accept, says which it accepts, and records nothing', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir, protocol: '2.0.0' });
    expect(response).toMatchObject({ status: 'rejected', supported: '^1.0.0' });
    expect(response.reason).toContain('2.0.0');
    expect(response.eventId).toBeUndefined();
    expect(historyFiles()).toEqual([]);
    expect(service.isIdle()).toBe(true);
  });

  it.each(['banana', '1', '', 1, null])('rejects the malformed protocol %j instead of throwing', async (protocol) => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir, protocol } as never);
    expect(response).toMatchObject({ status: 'rejected', supported: '^1.0.0' });
    expect(response.reason).toMatch(/protocol/i);
  });
});

describe('register-events (the event catalog, protocol 1.1.0)', () => {
  const declaration = { source: 'flow', events: [{ name: 'flow.step.started', description: 'A step began. Fires again on each retry.' }] };

  it('stores the declaration of a source and answers how many events it holds', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands['register-events']({ ...declaration, protocol: '1.1.0' });
    expect(response).toEqual({ status: 'registered', source: 'flow', count: 1 });
    expect(readCatalog(configDir).sources.map((source) => source.source)).toEqual(['flow']);
  });

  it('replaces what the source declared before', async () => {
    const service = createQueueService(configDir);
    await service.commands['register-events'](declaration);
    await service.commands['register-events']({ source: 'flow', events: [{ name: 'flow.other', description: 'd' }] });
    expect(readCatalog(configDir).sources[0]?.events.map((event) => event.name)).toEqual(['flow.other']);
  });

  it('rejects an invalid declaration with every problem and its path, and stores nothing', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands['register-events']({ source: 'Flow', events: [{ name: 'bad name', description: '' }] });
    expect(response.status).toBe('rejected');
    expect(response.problems?.map((problem) => problem.path)).toEqual(['source', 'events[0].name', 'events[0].description']);
    expect(response.reason).toContain('source');
    expect(readCatalog(configDir).sources).toEqual([]);
  });

  it('rejects a protocol it does not accept, like push does, and stores nothing', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands['register-events']({ ...declaration, protocol: '2.0.0' });
    expect(response).toMatchObject({ status: 'rejected', supported: '^1.0.0' });
    expect(readCatalog(configDir).sources).toEqual([]);
  });

  it('leaves the queue idle: it records nothing in the history or the WAL', async () => {
    const service = createQueueService(configDir);
    await service.commands['register-events'](declaration);
    expect(service.isIdle()).toBe(true);
  });
});

describe('push: a subscriber without a name', () => {
  let registryDir: string | undefined;

  afterEach(() => {
    if (registryDir !== undefined) {
      rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // when never matches: nothing is dispatched, the subscriber is only loaded
  const yml = (name: string): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      when: payload.never=1\n${name}`;

  it('answers aborted with the reason naming the file, the event, the index and the command that names it', async () => {
    const registered = await registerProjectWithSubscribers(yml(''));
    registryDir = registered.registryDir;
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(response.status).toBe('aborted');
    expect(response.reason).toContain("Subscriber 'onFoo' index 0");
    expect(response.reason).toContain('subscribers.yml');
    expect(response.reason).toContain('has no name');
    expect(response.reason).toContain('queue sub edit onFoo --index 0 --name <name> --scope project');
  });

  it('does not abort a push whose subscribers all have a name', async () => {
    registryDir = (await registerProjectWithSubscribers(yml('      name: notify\n'))).registryDir;
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(response.status).not.toBe('aborted');
  });
});

describe('push: the project of the working directory (project-sdk registry)', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // the messages of the log records (the lines are JSON: quotes and backslashes of a message are escaped there)
  const logLines = (): string[] => {
    const logsDir = join(configDir, 'logs');
    return existsSync(logsDir)
      ? readdirSync(logsDir)
          .flatMap((file) => readFileSync(join(logsDir, file), 'utf-8').split('\n'))
          .filter((line) => line !== '')
          .map((line) => {
            const record: unknown = JSON.parse(line);
            return isRecord(record) ? String(record['message'] ?? '') : '';
          })
      : [];
  };

  const historyEntries = (): Array<Record<string, unknown>> => {
    const dir = join(configDir, 'history');
    return readdirSync(dir)
      .flatMap((file) => readFileSync(join(dir, file), 'utf-8').split('\n'))
      .filter((line) => line !== '')
      .map((line) => {
        const record: unknown = JSON.parse(line);
        return isRecord(record) ? record : {};
      });
  };

  it('records the id of the registered project the working directory belongs to in the history of the push', async () => {
    const project = await addProject(registryDir, { name: 'app', path: projectDir });
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    expect(historyEntries()[0]).toMatchObject({ event: 'onNobodyListens', projectId: project.id });
    expect(logLines().filter((line) => line.includes('not inside any registered project'))).toEqual([]);
  });

  it('warns once per working directory, with the command that registers it, when no registered project contains it; the history has no project id', async () => {
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    const warnings = logLines().filter((line) => line.includes('not inside any registered project'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`project add "${projectDir}"`);
    expect(historyEntries()[0]?.['projectId']).toBeUndefined();
  });

  it('logs an unreadable registry with its reason (once), and still delivers: the push does not fail because of the registry', async () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    const service = createQueueService(configDir, { registryDir });
    const first = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir });
    expect(first).toMatchObject({ status: 'queued' });
    expect(logLines().filter((line) => line.includes('could not be read'))).toHaveLength(1);
  });

  it('aborts the push, naming the old .queue/subscribers.yml and the file to move it to, when the project has no file yet', async () => {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    const file = join(projectDir, '.queue', 'subscribers.yml');
    writeFileSync(file, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: n\n      when: payload.never=1\n');
    const project = await addProject(registryDir, { name: 'app', path: projectDir });
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(response.status).toBe('aborted');
    expect(response.reason).toContain(file);
    expect(response.reason).toContain(join(projectToolDir(registryDir, project.id, 'queue', 'config'), 'subscribers.yml'));
  });
});

describe('push: an explicit project (protocol 1.2.0)', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const historyEntries = (): Array<Record<string, unknown>> => {
    const dir = join(configDir, 'history');
    return existsSync(dir)
      ? readdirSync(dir)
          .flatMap((file) => readFileSync(join(dir, file), 'utf-8').split('\n'))
          .filter((line) => line !== '')
          .map((line) => {
            const record: unknown = JSON.parse(line);
            return isRecord(record) ? record : {};
          })
      : [];
  };

  it('records the given project, even for a working directory that lies in another registered project or in none', async () => {
    const wanted = await addProject(registryDir, { name: 'wanted', path: projectDir });
    const other = mkdtempSync(join(tmpdir(), 'queue-service-other-'));
    try {
      await addProject(registryDir, { name: 'other', path: other });
      const service = createQueueService(configDir, { registryDir });
      const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: other, project: wanted.id, protocol: '1.2.0' });
      expect(response).toMatchObject({ status: 'queued' });
      expect(historyEntries()[0]).toMatchObject({ projectId: wanted.id });
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('rejects an id the registry does not know, saying how to list the projects, and records nothing', async () => {
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir, project: 'deadbeef', protocol: '1.2.0' });
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain("'deadbeef'");
    expect(response.reason).toContain('project list');
    expect(historyEntries()).toEqual([]);
  });

  it('rejects a project when the daemon has no registry to check it against, instead of trusting it', async () => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event: 'onNobodyListens', payload: {}, cwd: projectDir, project: 'deadbeef', protocol: '1.2.0' });
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain('registry');
    expect(historyEntries()).toEqual([]);
  });
});

describe('the project of a push follows the event into the WAL and the DLQ (meta.projectId)', () => {
  it('a dispatch that fails for good lands in the DLQ with the id of the project of the push', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
    try {
      const project = await addProject(registryDir, { name: 'app', path: projectDir });
      writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      name: fails\n      command: node -e "process.exit(1)"\n      retries: 0\n');
      const service = createQueueService(configDir, { registryDir });
      await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
      await waitFor('the failed dispatch to reach the DLQ', () => listDlqEntries(configDir).length === 1 && service.isIdle());
      expect(listDlqEntries(configDir)[0]?.meta).toMatchObject({ projectId: project.id });
    } finally {
      rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('subscribers kept in the config folder of the registered project', () => {
  let registryDir: string;
  const YML = (name: string): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: ${name}\n      when: payload.never=1\n`;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const logMessages = (): string[] => {
    const logsDir = join(configDir, 'logs');
    return existsSync(logsDir)
      ? readdirSync(logsDir)
          .flatMap((file) => readFileSync(join(logsDir, file), 'utf-8').split('\n'))
          .filter((line) => line !== '')
          .map((line) => {
            const record: unknown = JSON.parse(line);
            return isRecord(record) ? String(record['message'] ?? '') : '';
          })
      : [];
  };

  const triggerCounts = (): number[] => {
    const dir = join(configDir, 'history');
    return readdirSync(dir)
      .flatMap((file) => readFileSync(join(dir, file), 'utf-8').split('\n'))
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line))
      .filter(isRecord)
      // a subscriber whose filter did not match leaves a 'filtered' record next to the trigger
      .filter((record) => record['type'] === 'trigger')
      .map((record) => Number(record['totalCount']));
  };

  async function registerWithFile(yml: string): Promise<string> {
    const project = await addProject(registryDir, { name: 'app', path: projectDir });
    const dir = projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true });
    writeFileSync(join(dir, 'subscribers.yml'), yml);
    return project.id;
  }

  it('loads the subscribers of the file of the project, wherever the push comes from inside the project', async () => {
    await registerWithFile(YML('reg'));
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: join(projectDir, 'src') });
    expect(triggerCounts()).toEqual([1]);
  });

  it('loads them for an explicit project too, whatever the working directory of the push', async () => {
    const id = await registerWithFile(YML('reg'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'queue-service-elsewhere-'));
    try {
      const service = createQueueService(configDir, { registryDir });
      await service.commands.push({ event: 'onFoo', payload: {}, cwd: elsewhere, project: id, protocol: '1.2.0' });
      expect(triggerCounts()).toEqual([1]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('ignores a .queue/subscribers.yml found above once the project has its file, and says so once, naming the file to delete', async () => {
    await registerWithFile(YML('reg'));
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    const legacy = join(projectDir, '.queue', 'subscribers.yml');
    writeFileSync(legacy, YML('legacy1').replace('legacy1', 'legacy1') + '    - type: cli\n      command: echo y\n      name: legacy2\n      when: payload.never=1\n');
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(triggerCounts()).toEqual([1, 1]);
    const notes = logMessages().filter((line) => line.includes('is ignored'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(legacy);
  });
});

describe('the project chain of an event (Decision #29): parents, virtual projects', () => {
  let registryDir: string;
  let parentDir: string;
  const NEVER = (name: string): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: ${name}\n      when: payload.never=1\n`;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
    parentDir = mkdtempSync(join(tmpdir(), 'queue-service-parent-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(parentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // the registry stores paths with forward slashes
  const slash = (path: string): string => path.replace(/\\/g, '/');

  const writeFor = (id: string, yml: string): void => {
    writeFileSync(join(projectToolDir(registryDir, id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
  };

  const triggerCounts = (): number[] => {
    const dir = join(configDir, 'history');
    return existsSync(dir)
      ? readdirSync(dir)
          .flatMap((file) => readFileSync(join(dir, file), 'utf-8').split('\n'))
          .filter((line) => line !== '')
          .map((line): unknown => JSON.parse(line))
          .filter(isRecord)
          .filter((record) => record['type'] === 'trigger')
          .map((record) => Number(record['totalCount']))
      : [];
  };

  async function parentAndChild(): Promise<{ parentId: string; childId: string }> {
    const parent = await addProject(registryDir, { name: 'parent', path: parentDir });
    const child = await addProject(registryDir, { name: 'child', path: projectDir, parent: 'parent' });
    writeFor(parent.id, NEVER('p'));
    writeFor(child.id, NEVER('c'));
    return { parentId: parent.id, childId: child.id };
  }

  it('an event pushed in a child project reaches the subscribers of the child and of its parent', async () => {
    await parentAndChild();
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: join(projectDir, 'src') });
    expect(triggerCounts()).toEqual([2]);
  });

  it('the same through an explicit project, whatever the working directory', async () => {
    const { childId } = await parentAndChild();
    const elsewhere = mkdtempSync(join(tmpdir(), 'queue-service-elsewhere-'));
    try {
      const service = createQueueService(configDir, { registryDir });
      await service.commands.push({ event: 'onFoo', payload: {}, cwd: elsewhere, project: childId, protocol: '1.2.0' });
      expect(triggerCounts()).toEqual([2]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('lists the subscribers of the parents too, each running from the main folder of its own project', async () => {
    const { parentId, childId } = await parentAndChild();
    const service = createQueueService(configDir, { registryDir });
    const { subscribers } = await service.commands['list-subscribers']({ event: 'onFoo', cwd: projectDir });
    expect(subscribers.map((sub) => [sub.subscriberId, sub.cwd])).toEqual([
      [`${parentId}/p`, slash(parentDir)],
      [`${childId}/c`, slash(projectDir)],
    ]);
  });

  it('accepts an event of a virtual project (no path) without a working directory, and records its project', async () => {
    const virtual = await addProject(registryDir, { name: 'virtual-app' });
    writeFor(virtual.id, NEVER('v'));
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, project: virtual.id, protocol: '1.3.0' } as never);
    expect(response.status).toBe('queued');
    expect(triggerCounts()).toEqual([1]);
  });

  it('a cli subscriber of a virtual project with no cwd of its own fails loudly (failed in the WAL, with the reason), naming the project', async () => {
    const virtual = await addProject(registryDir, { name: 'virtual-app' });
    writeFor(virtual.id, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: v\n      retries: 0\n');
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, project: virtual.id, protocol: '1.3.0' } as never);
    const walEntries = (): Array<{ status: string; lastError?: string }> => new Wal(join(configDir, 'wal.ndjson')).readAll();
    await waitFor('the misconfigured dispatch to fail', () => walEntries().some((entry) => entry.status === 'failed') && service.isIdle());
    expect(walEntries()[0]?.lastError).toContain("'virtual-app'");
  });
});

describe('direction of a push (protocol 1.4.0, Decision #29): to-parents, to-children', () => {
  let registryDir: string;
  let grandDir: string;
  let parentDir: string;
  const RUN = (name: string): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: node -e ""\n      name: ${name}\n`;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'queue-service-registry-'));
    grandDir = mkdtempSync(join(tmpdir(), 'queue-service-grand-'));
    parentDir = mkdtempSync(join(tmpdir(), 'queue-service-parent-'));
  });

  afterEach(() => {
    for (const dir of [registryDir, grandDir, parentDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  /** grand (root) > parent > child (projectDir), each with one subscriber named after it. */
  async function family(): Promise<{ grand: string; parent: string; child: string }> {
    const grand = await addProject(registryDir, { name: 'grand', path: grandDir });
    const parent = await addProject(registryDir, { name: 'parent', path: parentDir, parent: 'grand' });
    const child = await addProject(registryDir, { name: 'child', path: projectDir, parent: 'parent' });
    for (const [project, name] of [[grand, 'g'], [parent, 'p'], [child, 'c']] as const) {
      writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), RUN(name));
    }
    return { grand: grand.id, parent: parent.id, child: child.id };
  }

  const walEntries = (): WalEntry[] => new Wal(join(configDir, 'wal.ndjson')).readAll();

  async function pushFrom(project: string, direction?: unknown): Promise<{ status: string; reason?: string }> {
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, project, protocol: '1.4.0', ...(direction !== undefined && { direction }) } as never);
    await waitFor('the dispatches to finish', () => service.isIdle());
    return response;
  }

  it('by default (to-parents) the emitter and its ancestors fire, never the descendants', async () => {
    const ids = await family();
    await pushFrom(ids.parent);
    expect(walEntries().map((entry) => entry.subscriberId).sort()).toEqual([`${ids.grand}/g`, `${ids.parent}/p`].sort());
  });

  it('to-children fires the emitter and its descendants (their own file), not the ancestors; each descendant carries its own project id and the emitter in emitterProjectId', async () => {
    const ids = await family();
    await pushFrom(ids.parent, ['to-children']);
    const entries = walEntries();
    expect(entries.map((entry) => entry.subscriberId).sort()).toEqual([`${ids.parent}/p`, `${ids.child}/c`].sort());
    const child = entries.find((entry) => entry.subscriberId === `${ids.child}/c`)!;
    expect(child.meta).toMatchObject({ projectId: ids.child, emitterProjectId: ids.parent });
    const own = entries.find((entry) => entry.subscriberId === `${ids.parent}/p`)!;
    expect(own.meta['projectId']).toBe(ids.parent);
    expect(own.meta['emitterProjectId']).toBeUndefined();
  });

  it('both values fire the ancestors, the emitter and the descendants, each subscriber once', async () => {
    const ids = await family();
    await pushFrom(ids.parent, ['to-parents', 'to-children']);
    expect(walEntries().map((entry) => entry.subscriberId).sort()).toEqual([`${ids.grand}/g`, `${ids.parent}/p`, `${ids.child}/c`].sort());
  });

  it('rejects an unknown direction with the accepted values, and records nothing', async () => {
    const ids = await family();
    const response = await pushFrom(ids.parent, ['sideways']);
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain('sideways');
    expect(response.reason).toContain('to-parents');
    expect(response.reason).toContain('to-children');
    expect(walEntries()).toEqual([]);
  });

  it('rejects a direction that is not a non-empty list', async () => {
    const ids = await family();
    for (const bad of ['to-children', [], 3]) {
      const response = await pushFrom(ids.parent, bad);
      expect(response.status, JSON.stringify(bad)).toBe('rejected');
    }
  });

  it('refuses to-children for a before* event (synchronous, one answer): says so, records nothing', async () => {
    const ids = await family();
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'beforeSave', payload: {}, project: ids.parent, protocol: '1.4.0', direction: ['to-children'] } as never);
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain('before');
    expect(walEntries()).toEqual([]);
  });

  it('refuses to-children when the event belongs to no registered project: the descendants cannot be known', async () => {
    const service = createQueueService(configDir, { registryDir });
    const response = await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir, protocol: '1.4.0', direction: ['to-children'] } as never);
    expect(response.status).toBe('rejected');
    expect(response.reason).toContain('registered project');
  });

  it('a descendant entry that fails for good reaches the DLQ with its own project id and the emitter id', async () => {
    const ids = await family();
    writeFileSync(join(projectToolDir(registryDir, ids.child, 'queue', 'config'), 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      command: node -e "process.exit(1)"\n      name: c\n      retries: 0\n');
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, project: ids.parent, protocol: '1.4.0', direction: ['to-children'] } as never);
    await waitFor('the failed dispatch to reach the DLQ', () => listDlqEntries(configDir).length === 1 && service.isIdle());
    expect(listDlqEntries(configDir)[0]?.meta).toMatchObject({ projectId: ids.child, emitterProjectId: ids.parent });
  });
});
