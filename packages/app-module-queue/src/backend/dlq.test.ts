import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { DaemonUnreachableError } from './errors.js';

let configDir: string;

const dlqLine = (id: string) => JSON.stringify({ id, event: 'onFoo', payload: {}, meta: { cwd: '/p', projectName: 'p' }, subscriberId: 's', attempts: 3, lastError: 'x', movedAt: '2026-10-18T12:00:00.000Z' });

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-dlq-'));
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('dlq reads and clearing work on the queue files directly', () => {
  it('listDlq returns the entries without any daemon', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), dlqLine('d1') + '\n');
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d1']);
    expect(mockIsRunning).not.toHaveBeenCalled();
  });

  it('clearDlqEntry with an id removes just that entry and reports how many', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    expect(clearDlqEntry(configDir, 'd1')).toEqual({ cleared: 1 });
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d2']);
  });

  it('clearDlqEntry without an id clears all entries', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    expect(clearDlqEntry(configDir)).toEqual({ cleared: 2 });
    expect(listDlq(configDir)).toEqual([]);
    expect(mockIsRunning).not.toHaveBeenCalled();
  });
});

describe('replaying a DLQ entry still goes through the daemon (it runs the subscriber)', () => {
  it('throws DaemonUnreachableError when the daemon is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(replayDlqEntry(configDir, 'd1')).rejects.toThrow(DaemonUnreachableError);
  });

  it('sends the id', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok' });
    expect(await replayDlqEntry(configDir, 'd1')).toEqual({ status: 'ok' });
    expect(mockSend).toHaveBeenCalledWith('dlq-replay', { id: 'd1' });
  });
});
