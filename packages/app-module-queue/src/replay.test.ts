import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { replayEvent } from './replay.js';
import { DaemonUnreachableError, ReplayError, ReplayNotFoundError } from './errors.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-queue-replay-'));
  mkdirSync(join(configDir, 'history'));
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeTrigger(eventId: string, event: string, payload?: unknown, cwd?: string): void {
  const record: Record<string, unknown> = { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId, event, matchedCount: 0, totalCount: 0 };
  if (payload !== undefined) {
    record.payload = payload;
  }
  if (cwd !== undefined) {
    record.cwd = cwd;
  }
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify(record) + '\n');
}

describe('replayEvent', () => {
  it('throws ReplayNotFoundError when the eventId has no history entry', async () => {
    await expect(replayEvent(configDir, 'missing')).rejects.toThrow(ReplayNotFoundError);
  });

  it('throws ReplayError when the entry has no recorded payload', async () => {
    writeTrigger('e1', 'onFoo');
    await expect(replayEvent(configDir, 'e1')).rejects.toThrow(ReplayError);
  });

  it('throws DaemonUnreachableError when the daemon is not running', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'replay-project-'));
    try {
      writeTrigger('e1', 'onFoo', { a: 1 }, projectDir);
      mockIsRunning.mockResolvedValue(false);
      await expect(replayEvent(configDir, 'e1')).rejects.toThrow(DaemonUnreachableError);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('pushes the recorded payload tagged with replayOf', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'replay-project-'));
    try {
      writeTrigger('e1', 'onFoo', { a: 1 }, projectDir);
      mockIsRunning.mockResolvedValue(true);
      mockSend.mockResolvedValue({ status: 'queued', eventId: 'e2' });

      const response = await replayEvent(configDir, 'e1');

      expect(response).toEqual({ status: 'queued', eventId: 'e2' });
      expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ event: 'onFoo', payload: { a: 1 }, replayOf: 'e1', cwd: projectDir }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('throws ReplayError when entry has no recorded cwd', async () => {
    writeTrigger('e1', 'onFoo', { a: 1 });
    mockIsRunning.mockResolvedValue(true);

    await expect(replayEvent(configDir, 'e1')).rejects.toThrow(ReplayError);
    const err = await replayEvent(configDir, 'e1').catch(e => e);
    expect(err.message).toMatch(/has no recorded working directory/);
    expect(err.message).toMatch(/cd .* && queue replay/);
  });

  it('throws ReplayError when entry has cwd but directory no longer exists', async () => {
    const missingDir = '/this/path/definitely/does/not/exist/queue-replay-test-' + Math.random();
    const record: Record<string, unknown> = {
      type: 'trigger',
      ts: '2026-01-01T00:00:00.000Z',
      eventId: 'e1',
      event: 'onFoo',
      matchedCount: 0,
      totalCount: 0,
      payload: { a: 1 },
      cwd: missingDir,
    };
    writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify(record) + '\n');
    mockIsRunning.mockResolvedValue(true);

    await expect(replayEvent(configDir, 'e1')).rejects.toThrow(ReplayError);
    const err = await replayEvent(configDir, 'e1').catch(e => e);
    expect(err.message).toMatch(/working directory.*no longer exists/);
    expect(err.message).toContain(missingDir);
  });

  it('uses entry.cwd when recorded and directory exists', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'replay-project-'));
    try {
      const record: Record<string, unknown> = {
        type: 'trigger',
        ts: '2026-01-01T00:00:00.000Z',
        eventId: 'e1',
        event: 'onFoo',
        matchedCount: 0,
        totalCount: 0,
        payload: { a: 1 },
        cwd: projectDir,
      };
      writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify(record) + '\n');
      mockIsRunning.mockResolvedValue(true);
      mockSend.mockResolvedValue({ status: 'queued', eventId: 'e2' });

      const response = await replayEvent(configDir, 'e1');

      expect(response).toEqual({ status: 'queued', eventId: 'e2' });
      expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ cwd: projectDir, replayOf: 'e1' }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('error order: missing cwd takes precedence over daemon unreachable', async () => {
    // Create entry with missing cwd
    const missingDir = '/this/path/definitely/does/not/exist/queue-replay-test-' + Math.random();
    const record: Record<string, unknown> = {
      type: 'trigger',
      ts: '2026-01-01T00:00:00.000Z',
      eventId: 'e1',
      event: 'onFoo',
      matchedCount: 0,
      totalCount: 0,
      payload: { a: 1 },
      cwd: missingDir,
    };
    writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify(record) + '\n');
    // Mock daemon as not running
    mockIsRunning.mockResolvedValue(false);

    // Verify that the error is the cwd error, not the daemon error
    // (cwd check happens before daemon check)
    const err = await replayEvent(configDir, 'e1').catch(e => e);
    expect(err).toBeInstanceOf(ReplayError);
    expect(err.message).toMatch(/working directory.*no longer exists/);
    expect(err.message).not.toMatch(/Daemon is not running/);
  });
});
