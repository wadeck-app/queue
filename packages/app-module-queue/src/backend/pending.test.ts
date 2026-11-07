import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { listPending, giveUpPending, giveUpStuck } from './pending.js';
import { InvalidQueryError, PendingNotFoundError, NotInFlightError } from './errors.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-pending-'));
  mockSend.mockReset();
  mockIsRunning.mockReset();
  // no daemon unless a test starts one
  mockIsRunning.mockResolvedValue(false);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const walLine = (id: string, status: string, extra: object = {}) => JSON.stringify({
  id, timestamp: '2026-10-19T10:00:00.000Z', event: 'onFoo', payload: { secret: 'token-123' }, meta: { cwd: '/p', projectName: 'p' }, subscriberId: 'onFoo[0]', status, attempts: 1, ...extra,
});

describe('listPending', () => {
  it('lists the events still on their way, without their payload', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('p 1', 'pending'), walLine('a1', 'acked'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n');
    const result = listPending(configDir);
    expect(result.entries).toEqual([
      { id: 'p 1', idShort: 'p 1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'pending', stateText: 'pending, 1 attempt', attempts: 1, lastError: null, detailsText: '**Id** `p 1`', queuedAt: '2026-10-19T10:00:00.000Z' },
      { id: 'f1', idShort: 'f1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'failed', stateText: 'failed, 1 attempt', attempts: 1, lastError: 'exit code 1', detailsText: '**Last error** `exit code 1`\n\n**Id** `f1`', queuedAt: '2026-10-19T10:00:00.000Z' },
    ]);
    expect(result.awaitingRetry).toBe(1);
    expect(JSON.stringify(result)).not.toContain('token-123');
  });

  it('is empty without a WAL', () => {
    expect(listPending(configDir)).toEqual({ entries: [], awaitingRetry: 0, stuckCount: 0, stuckText: '' });
  });
});

describe('giveUpPending (move an event nobody will retry to the dead-letter queue)', () => {
  it('moves the entry to the DLQ, where it can be replayed or cleared, and it is no longer pending', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('p1', 'pending'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok', accepted: 1 });
    expect(await giveUpPending(configDir, 'f1')).toEqual({ status: 'moved' });
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['p1']);
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('exit code 1 (given up by hand)');
  });

  it('tells the daemon afterwards (dlq-notify, kind added, reason given-up), with the entry as stored but without the payload of the failed event', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('f1', 'failed', { lastError: 'exit code 1' }) + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok', accepted: 1 });
    await giveUpPending(configDir, 'f1');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command, request] = mockSend.mock.calls[0] as [string, { kind: string; entries: Array<{ entry: { id: string; payload: unknown; lastError: string }; reason: string }> }];
    expect(command).toBe('dlq-notify');
    expect(request.kind).toBe('added');
    expect(request.entries).toHaveLength(1);
    expect(request.entries[0]!.reason).toBe('given-up');
    expect(request.entries[0]!.entry).toMatchObject({ id: 'f1', lastError: 'exit code 1 (given up by hand)', payload: null });
    expect(JSON.stringify(request)).not.toContain('token-123');
  });

  it('the move stands and the message says the event could not be sent when the daemon is not running (never started for this)', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('f1', 'failed') + '\n');
    const result = await giveUpPending(configDir, 'f1');
    expect(result.status).toBe('moved');
    expect(result.message).toContain('Moved to the dead-letter queue.');
    expect(result.message).toContain('queue.dlq.added (1 entry)');
    expect(result.message).toContain('could not be sent because the daemon is not running');
    expect(result.message).toContain('queue start');
    expect(mockSend).not.toHaveBeenCalled();
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('f1');
  });

  it('the move stands and the message carries the reason when the daemon refuses the notification or fails', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('f1', 'failed'), walLine('f2', 'failed')].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValueOnce({ status: 'rejected', reason: 'dlq-notify refused: bad' });
    const refused = await giveUpPending(configDir, 'f1');
    expect(refused.message).toContain('the daemon refused it (dlq-notify refused: bad)');
    mockSend.mockRejectedValueOnce(new Error('Unknown command: dlq-notify'));
    const old = await giveUpPending(configDir, 'f2');
    expect(old.message).toContain('Unknown command: dlq-notify');
    expect(old.message).toContain('restart it');
  });

  it('does not contact the daemon when the move fails', async () => {
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(PendingNotFoundError);
    expect(mockIsRunning).not.toHaveBeenCalled();
  });

  it('says the id is unknown with PendingNotFoundError', async () => {
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(PendingNotFoundError);
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(/No pending event with id nope/);
  });

  it('says an entry already delivered or given up is not in flight with NotInFlightError', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('a1', 'acked') + '\n');
    await expect(giveUpPending(configDir, 'a1')).rejects.toThrow(NotInFlightError);
  });

  it('is an InvalidQueryError-free API: a bad id is just not found', async () => {
    await expect(giveUpPending(configDir, '')).rejects.toThrow(PendingNotFoundError);
    expect(InvalidQueryError).toBeDefined();
  });
});

describe('stuck events (in flight for so long that nobody retries them any more)', () => {
  const old = (id: string, status: string) => walLine(id, status, { timestamp: '2026-09-02T10:00:00.000Z' });

  it('counts them and says so in a sentence the page can show, and says nothing when there are none', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [old('a', 'failed'), old('b', 'pending'), walLine('c', 'failed', { timestamp: new Date().toISOString() })].join('\n') + '\n');
    const result = listPending(configDir);
    expect(result.stuckCount).toBe(2);
    expect(result.stuckText).toBe('2 events have been in flight for more than 2 hours: nobody retries them any more.');
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('c', 'failed', { timestamp: new Date().toISOString() }) + '\n');
    expect(listPending(configDir)).toMatchObject({ stuckCount: 0, stuckText: '' });
  });

  it('says "1 event has" for one', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), old('a', 'failed') + '\n');
    expect(listPending(configDir).stuckText).toBe('1 event has been in flight for more than 2 hours: nobody retries it any more.');
  });

  it('giveUpStuck moves them all to the DLQ and answers how many, leaving the recent ones; the daemon is told once with all of them', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [old('a', 'failed'), old('b', 'pending'), walLine('c', 'failed', { timestamp: new Date().toISOString() })].join('\n') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok', accepted: 2 });
    expect(await giveUpStuck(configDir)).toEqual({ moved: 2 });
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['c']);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect((mockSend.mock.calls[0]![1] as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('giveUpStuck says in its message that the events could not be announced when the daemon is not running, and says nothing when nothing moved', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [old('a', 'failed'), old('b', 'pending')].join('\n') + '\n');
    const result = await giveUpStuck(configDir);
    expect(result.moved).toBe(2);
    expect(result.message).toContain('2 stuck events moved to the dead-letter queue.');
    expect(result.message).toContain('queue.dlq.added (2 entries)');
    expect(result.message).toContain('daemon is not running');
    mockIsRunning.mockClear();
    expect(await giveUpStuck(configDir)).toEqual({ moved: 0 });
    expect(mockIsRunning).not.toHaveBeenCalled();
  });
});
