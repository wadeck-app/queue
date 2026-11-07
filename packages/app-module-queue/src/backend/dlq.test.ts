import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('dlq reads work on the queue files directly', () => {
  it('listDlq returns the entries without any daemon', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), dlqLine('d1') + '\n');
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d1']);
    expect(mockIsRunning).not.toHaveBeenCalled();
  });
});

// R2a item 1: with the daemon up the module does NOT touch the files, it asks the daemon (which clears AND emits queue.dlq.removed from the rows it removed).
// Without a daemon it clears the files itself and says, loudly, that the event could not be sent. It never starts the daemon.
describe('clearDlqEntry, daemon reachable: the daemon does the work', () => {
  beforeEach(() => {
    mockIsRunning.mockResolvedValue(true);
  });

  it('sends dlq-clear with the id only and returns the daemon count; the module wrote nothing to the DLQ file', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    mockSend.mockResolvedValue({ cleared: 1 });
    expect(await clearDlqEntry(configDir, 'd1')).toEqual({ cleared: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('dlq-clear', { id: 'd1' });
    // the (mocked) daemon removed nothing and the module did not either: the file is as it was
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d1', 'd2']);
  });

  it('passes the reason through when the daemon refuses the request as malformed (cleared 0 plus reason), so the route can say why', async () => {
    mockSend.mockResolvedValue({ cleared: 0, reason: 'dlq-clear needs the id of one entry' });
    expect(await clearDlqEntry(configDir, 'd1')).toEqual({ cleared: 0, reason: 'dlq-clear needs the id of one entry' });
  });

  it('without an id the whole queue is cleared by the daemon in ONE request (no chunks, no entries sent)', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 450 }, (_, i) => dlqLine('d' + i)).join('\n') + '\n');
    mockSend.mockResolvedValue({ cleared: 450 });
    expect(await clearDlqEntry(configDir)).toEqual({ cleared: 450 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]).toEqual(['dlq-clear', {}]);
    expect(listDlq(configDir)).toHaveLength(450);
  });

  it('an unknown id answers the daemon count 0 and no message', async () => {
    mockSend.mockResolvedValue({ cleared: 0 });
    expect(await clearDlqEntry(configDir, 'nope')).toEqual({ cleared: 0 });
  });

  it('when the RPC fails the clear is done on the files and the message carries the failure and the restart hint (never silent)', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2')].join('\n') + '\n');
    mockSend.mockRejectedValueOnce(new Error('Unknown command: dlq-clear'));
    const result = await clearDlqEntry(configDir, 'd1');
    expect(result.cleared).toBe(1);
    expect(result.message).toContain('Entry removed.');
    expect(result.message).toContain('Unknown command: dlq-clear');
    expect(result.message).toContain('restart it');
    expect(listDlq(configDir).map(e => e.id)).toEqual(['d2']);
  });
});

describe('clearDlqEntry, daemon not running: the files are cleared and the message says the event was not sent', () => {
  it('clears one entry or all of them, sends nothing, and says it with the count', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), [dlqLine('d1'), dlqLine('d2'), dlqLine('d3')].join('\n') + '\n');
    const one = await clearDlqEntry(configDir, 'd1');
    expect(one.cleared).toBe(1);
    expect(one.message).toContain('Entry removed.');
    expect(one.message).toContain('queue.dlq.removed (1 entry) event could not be sent because the daemon is not running');
    const rest = await clearDlqEntry(configDir);
    expect(rest.cleared).toBe(2);
    expect(rest.message).toContain('2 entries removed.');
    expect(rest.message).toContain('queue.dlq.removed (2 entries) event could not be sent because the daemon is not running');
    expect(rest.message).toContain('queue start');
    expect(mockSend).not.toHaveBeenCalled();
    expect(listDlq(configDir)).toEqual([]);
  });

  it('also purges the WAL entry that carried the payload of a cleared row', async () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), dlqLine('d1') + '\n');
    writeFileSync(join(configDir, 'wal.ndjson'), JSON.stringify({ id: 'd1', timestamp: '2026-10-18T10:00:00.000Z', event: 'onFoo', payload: { secret: 'S3CRET' }, meta: { cwd: '/p' }, subscriberId: 's', status: 'dlq', attempts: 3 }) + '\n');
    await clearDlqEntry(configDir, 'd1');
    expect(readFileSync(join(configDir, 'wal.ndjson'), 'utf8')).not.toContain('S3CRET');
  });

  it('an unknown id clears 0 and says nothing (nothing was removed, so there is nothing to announce)', async () => {
    expect(await clearDlqEntry(configDir, 'nope')).toEqual({ cleared: 0 });
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
