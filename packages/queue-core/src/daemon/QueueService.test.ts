import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';

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
