import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { readCatalog } from '../catalog/EventCatalog.js';
import { Wal } from '../storage/Wal.js';

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
  });
});
