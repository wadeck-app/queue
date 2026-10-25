import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { readCatalog } from '../catalog/EventCatalog.js';
import { Wal } from '../storage/Wal.js';
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

describe('push: warning for a subscriber without a name', () => {
  // when never matches: nothing is dispatched, the subscriber is only loaded
  const yml = (name: string): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      when: payload.never=1\n${name}`;

  const warnings = (): string[] => {
    const logsDir = join(configDir, 'logs');
    return readdirSync(logsDir)
      .flatMap((file) => readFileSync(join(logsDir, file), 'utf-8').split('\n'))
      .filter((line) => line.includes('has no name'));
  };

  it('logs one actionable diagnostic per unnamed subscriber, not one per push', async () => {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), yml(''));
    const service = createQueueService(configDir);
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    const lines = warnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('queue sub edit onFoo --index 0 --name <name>');
  });

  it('logs nothing for a named subscriber', async () => {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), yml('      name: notify\n'));
    const service = createQueueService(configDir);
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    expect(existsSync(join(configDir, 'logs')) ? warnings() : []).toEqual([]);
  });
});

describe('retry of an entry written before subscriber names and scopes', () => {
  it('finds the subscriber again through its legacy position id', async () => {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      command: node -e ""\n');
    new Wal(join(configDir, 'wal.ndjson')).append({
      id: 'evt-legacy',
      timestamp: new Date().toISOString(),
      event: 'onFoo',
      payload: {},
      meta: { cwd: projectDir },
      subscriberId: 'onFoo[0]',
      status: 'failed',
      attempts: 1,
    });
    const service = createQueueService(configDir);
    expect(await service.commands.retry({ eventId: 'evt-legacy' })).toEqual({ status: 'ok' });
    // the retry runs the subscriber: its process must be gone before the afterEach removes the directory it runs in
    await waitFor('the retry to finish', () => service.isIdle());
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

  it('logs, once per file, that a subscribers.yml found by walking up is used as a transition, naming the file and what replaces it', async () => {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    const file = join(projectDir, '.queue', 'subscribers.yml');
    writeFileSync(file, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: n\n      when: payload.never=1\n');
    await addProject(registryDir, { name: 'app', path: projectDir });
    const service = createQueueService(configDir, { registryDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    await service.commands.push({ event: 'onFoo', payload: {}, cwd: projectDir });
    const lines = logLines().filter((line) => line.includes('transition'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(file);
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
      mkdirSync(join(projectDir, '.queue'), { recursive: true });
      writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      name: fails\n      command: node -e "process.exit(1)"\n      retries: 0\n');
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
    expect(logMessages().filter((line) => line.includes('transition'))).toEqual([]);
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
