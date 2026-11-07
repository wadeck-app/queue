import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  // no daemon unless a test starts one
  mockIsRunning.mockResolvedValue(false);
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

  it('clearDlqEntry with an id removes just that entry and reports how many; the daemon is told (dlq-notify, kind removed, reason cleared)', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok', accepted: 1 });
    expect(await clearDlqEntry(configDir, 'd1')).toEqual({ cleared: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command, request] = mockSend.mock.calls[0] as [string, { kind: string; entries: Array<{ entry: { id: string; payload: unknown }; reason: string }> }];
    expect(command).toBe('dlq-notify');
    expect(request.kind).toBe('removed');
    expect(request.entries.map((item) => [item.entry.id, item.reason, item.entry.payload])).toEqual([['d1', 'cleared', null]]);
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d2']);
  });

  it('clearDlqEntry without an id clears all entries and announces each of them', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok', accepted: 2 });
    expect(await clearDlqEntry(configDir)).toEqual({ cleared: 2 });
    expect(listDlq(configDir)).toEqual([]);
    expect((mockSend.mock.calls[0]![1] as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('a clear of more than one chunk sends several requests', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 450 }, (_, i) => dlqLine('d' + i)).join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok' });
    expect(await clearDlqEntry(configDir)).toEqual({ cleared: 450 });
    expect(mockSend.mock.calls.map((call) => (call[1] as { entries: unknown[] }).entries.length)).toEqual([200, 200, 50]);
  });

  it('the clear stands and the message says the event could not be sent when the daemon is not running; nothing is sent', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    const result = await clearDlqEntry(configDir);
    expect(result.cleared).toBe(2);
    expect(result.message).toContain('2 entries removed.');
    expect(result.message).toContain('queue.dlq.removed (2 entries) event could not be sent because the daemon is not running');
    expect(result.message).toContain('queue start');
    expect(mockSend).not.toHaveBeenCalled();
    expect(listDlq(configDir)).toEqual([]);
  });

  it('says the daemon refused, or could not be reached, in the message; the clear stands', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValueOnce({ status: 'rejected', reason: 'because' });
    expect((await clearDlqEntry(configDir, 'd1')).message).toContain('the daemon refused it (because)');
    mockSend.mockRejectedValueOnce(new Error('socket closed'));
    const failed = await clearDlqEntry(configDir, 'd2');
    expect(failed.cleared).toBe(1);
    expect(failed.message).toContain('Entry removed.');
    expect(failed.message).toContain('socket closed');
  });

  it('an unknown id clears 0 and contacts nobody', async () => {
    expect(await clearDlqEntry(configDir, 'nope')).toEqual({ cleared: 0 });
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

describe('listDlq: project', () => {
  it('lists only the entries of that project when asked, all of them otherwise', () => {
    mkdirSync(configDir, { recursive: true });
    const line = (id: string, projectId?: string): string => JSON.stringify({ id, event: 'onFoo', payload: {}, meta: { cwd: '/p', ...(projectId !== undefined && { projectId }) }, subscriberId: 's', attempts: 3, lastError: 'x', movedAt: '2026-10-18T12:00:00.000Z' });
    writeFileSync(join(configDir, 'dlq.ndjson'), [line('a', '569c412d'), line('b', 'deadbeef'), line('c')].join('\n') + '\n');
    expect(listDlq(configDir).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(listDlq(configDir, '569c412d').map((e) => e.id)).toEqual(['a']);
    expect(listDlq(configDir, 'cafebabe')).toEqual([]);
  });
});
