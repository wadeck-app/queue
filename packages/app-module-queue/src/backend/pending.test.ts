import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { listPending, giveUpPending, giveUpStuck } from './pending.js';
import { InvalidQueryError, PendingNotFoundError, NotInFlightError } from './errors.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

let configDir: string;

beforeEach(() => {
  configDir = makeTempDir('app-module-pending-');
  mockSend.mockReset();
  mockIsRunning.mockReset();
  // no daemon unless a test starts one
  mockIsRunning.mockResolvedValue(false);
});

afterEach(() => {
  removeTempDir(configDir);
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

describe('giveUpPending, daemon reachable: the daemon moves the entry and emits the event', () => {
  beforeEach(() => {
    mockIsRunning.mockResolvedValue(true);
  });

  it('sends give-up with the id only; the module wrote nothing (the WAL is untouched, the DLQ file does not exist)', async () => {
    const wal = [walLine('p1', 'pending'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n';
    writeFileSync(join(configDir, 'wal.ndjson'), wal);
    mockSend.mockResolvedValue({ status: 'moved' });
    expect(await giveUpPending(configDir, 'f1')).toEqual({ status: 'moved' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('give-up', { id: 'f1' });
    expect(readFileSync(join(configDir, 'wal.ndjson'), 'utf8')).toBe(wal);
    expect(existsSync(join(configDir, 'dlq.ndjson'))).toBe(false);
  });

  it('maps the daemon answers not-found and not-in-flight to the errors the routes turn into 404 and 409', async () => {
    mockSend.mockResolvedValueOnce({ status: 'not-found' });
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(PendingNotFoundError);
    mockSend.mockResolvedValueOnce({ status: 'not-in-flight' });
    await expect(giveUpPending(configDir, 'a1')).rejects.toThrow(NotInFlightError);
  });

  it('a refusal of the daemon is an error with its reason (not a silent success)', async () => {
    mockSend.mockResolvedValueOnce({ status: 'rejected', reason: 'give-up needs the WAL id' });
    await expect(giveUpPending(configDir, '')).rejects.toThrow('give-up needs the WAL id');
  });

  it('when the RPC fails the move is done on the files and the message carries the failure and the restart hint', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('f1', 'failed') + '\n');
    mockSend.mockRejectedValueOnce(new Error('Unknown command: give-up'));
    const result = await giveUpPending(configDir, 'f1');
    expect(result.status).toBe('moved');
    expect(result.message).toContain('Moved to the dead-letter queue.');
    expect(result.message).toContain('Unknown command: give-up');
    expect(result.message).toContain('restart it');
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('f1');
  });
});

describe('giveUpPending, daemon not running: the move is done on the files and the message says the event was not sent', () => {
  it('moves the entry to the DLQ, where it can be replayed or cleared, and it is no longer pending', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('p1', 'pending'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n');
    const result = await giveUpPending(configDir, 'f1');
    expect(result.status).toBe('moved');
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['p1']);
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('exit code 1 (given up by hand)');
  });

  it('says in the message that the event could not be sent because the daemon is not running (never started for this)', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('f1', 'failed') + '\n');
    const result = await giveUpPending(configDir, 'f1');
    expect(result.message).toContain('Moved to the dead-letter queue.');
    expect(result.message).toContain('queue.dlq.added (1 entry)');
    expect(result.message).toContain('could not be sent because the daemon is not running');
    expect(result.message).toContain('queue start');
    expect(mockSend).not.toHaveBeenCalled();
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('f1');
  });

  it('says the id is unknown with PendingNotFoundError, and an entry already delivered or given up is not in flight with NotInFlightError', async () => {
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(PendingNotFoundError);
    await expect(giveUpPending(configDir, 'nope')).rejects.toThrow(/No pending event with id nope/);
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('a1', 'acked') + '\n');
    await expect(giveUpPending(configDir, 'a1')).rejects.toThrow(NotInFlightError);
  });

  it('is an InvalidQueryError-free API: a bad id is just not found (a 404 for the route, never a 400)', async () => {
    for (const id of ['', ' ', '../x']) {
      const error: unknown = await giveUpPending(configDir, id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PendingNotFoundError);
      expect(error).not.toBeInstanceOf(InvalidQueryError);
      expect((error as Error).message).toContain('only events still in the WAL can be given up');
    }
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

  it('giveUpStuck, daemon reachable: one give-up-stuck request with no data, the daemon moves them and emits; the module wrote nothing', async () => {
    const wal = [old('a', 'failed'), old('b', 'pending'), walLine('c', 'failed', { timestamp: new Date().toISOString() })].join('\n') + '\n';
    writeFileSync(join(configDir, 'wal.ndjson'), wal);
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ moved: 2 });
    expect(await giveUpStuck(configDir)).toEqual({ moved: 2 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('give-up-stuck', {});
    expect(readFileSync(join(configDir, 'wal.ndjson'), 'utf8')).toBe(wal);
    expect(existsSync(join(configDir, 'dlq.ndjson'))).toBe(false);
  });

  it('giveUpStuck, daemon not running: moves them on the files, leaves the recent ones, and says the events could not be announced; says nothing when nothing moved', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [old('a', 'failed'), old('b', 'pending'), walLine('c', 'failed', { timestamp: new Date().toISOString() })].join('\n') + '\n');
    const result = await giveUpStuck(configDir);
    expect(result.moved).toBe(2);
    expect(result.message).toContain('2 stuck events moved to the dead-letter queue.');
    expect(result.message).toContain('queue.dlq.added (2 entries)');
    expect(result.message).toContain('daemon is not running');
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['c']);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await giveUpStuck(configDir)).toEqual({ moved: 0 });
  });

  it('giveUpStuck, the RPC fails: done on the files, the message carries the failure', async () => {
    writeFileSync(join(configDir, 'wal.ndjson'), old('a', 'failed') + '\n');
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockRejectedValueOnce(new Error('Unknown command: give-up-stuck'));
    const result = await giveUpStuck(configDir);
    expect(result.moved).toBe(1);
    expect(result.message).toContain('Unknown command: give-up-stuck');
    expect(result.message).toContain('restart it');
  });
});
