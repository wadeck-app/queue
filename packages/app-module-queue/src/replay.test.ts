import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { replayEvent, ReplayError } from './replay.js';
import { DaemonUnreachableError } from './errors.js';

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

function writeTrigger(eventId: string, event: string, payload?: unknown): void {
  const record: Record<string, unknown> = { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId, event, matchedCount: 0, totalCount: 0 };
  if (payload !== undefined) record.payload = payload;
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify(record) + '\n');
}

describe('replayEvent', () => {
  it('throws ReplayError when the eventId has no history entry', async () => {
    await expect(replayEvent(configDir, 'missing')).rejects.toThrow(ReplayError);
  });

  it('throws ReplayError when the entry has no recorded payload', async () => {
    writeTrigger('e1', 'onFoo');
    await expect(replayEvent(configDir, 'e1')).rejects.toThrow(ReplayError);
  });

  it('throws DaemonUnreachableError when the daemon is not running', async () => {
    writeTrigger('e1', 'onFoo', { a: 1 });
    mockIsRunning.mockResolvedValue(false);
    await expect(replayEvent(configDir, 'e1')).rejects.toThrow(DaemonUnreachableError);
  });

  it('pushes the recorded payload tagged with replayOf', async () => {
    writeTrigger('e1', 'onFoo', { a: 1 });
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'queued', eventId: 'e2' });

    const response = await replayEvent(configDir, 'e1');

    expect(response).toEqual({ status: 'queued', eventId: 'e2' });
    expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ event: 'onFoo', payload: { a: 1 }, replayOf: 'e1' }));
  });
});
