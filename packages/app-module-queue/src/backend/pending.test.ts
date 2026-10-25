import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listPending, giveUpPending, giveUpStuck } from './pending.js';
import { InvalidQueryError, PendingNotFoundError, NotInFlightError } from './errors.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-pending-'));
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
  it('moves the entry to the DLQ, where it can be replayed or cleared, and it is no longer pending', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('p1', 'pending'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n');
    expect(giveUpPending(configDir, 'f1')).toEqual({ status: 'moved' });
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['p1']);
    expect(readFileSync(join(configDir, 'dlq.ndjson'), 'utf8')).toContain('exit code 1 (given up by hand)');
  });

  it('says the id is unknown with PendingNotFoundError', () => {
    expect(() => giveUpPending(configDir, 'nope')).toThrow(PendingNotFoundError);
    expect(() => giveUpPending(configDir, 'nope')).toThrow(/No pending event with id nope/);
  });

  it('says an entry already delivered or given up is not in flight with NotInFlightError', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), walLine('a1', 'acked') + '\n');
    expect(() => giveUpPending(configDir, 'a1')).toThrow(NotInFlightError);
  });

  it('is an InvalidQueryError-free API: a bad id is just not found', () => {
    expect(() => giveUpPending(configDir, '')).toThrow(PendingNotFoundError);
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

  it('giveUpStuck moves them all to the DLQ and answers how many, leaving the recent ones', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [old('a', 'failed'), old('b', 'pending'), walLine('c', 'failed', { timestamp: new Date().toISOString() })].join('\n') + '\n');
    expect(giveUpStuck(configDir)).toEqual({ moved: 2 });
    expect(listPending(configDir).entries.map((entry) => entry.id)).toEqual(['c']);
  });
});
