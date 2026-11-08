import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal } from './Wal.js';
import type { WalEntry } from './Wal.js';

// The primitives the DLQ paths rely on: compare-and-set under the lock, replace-by-id, conditional removal.

function makeEntry(overrides: Partial<WalEntry> = {}): WalEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: 'test.event',
    payload: { secret: 'S3CRET' },
    meta: { cwd: '/tmp' },
    subscriberId: 'sub-1',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

let tmpDir: string;
let wal: Wal;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wal-cond-test-'));
  wal = new Wal(join(tmpDir, 'wal.ndjson'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('Wal.updateEntryIf (compare-and-set under the lock)', () => {
  it('applies the update and returns the entry as it was when the predicate held', () => {
    wal.append(makeEntry({ id: 'a', status: 'failed', attempts: 2 }));
    const result = wal.updateEntryIf('a', (entry) => entry.status === 'failed', { status: 'dlq' });
    expect(result).toMatchObject({ status: 'updated', before: { id: 'a', status: 'failed', attempts: 2 } });
    expect(wal.readAll()[0]!.status).toBe('dlq');
  });

  it('refuses when the predicate does not hold now, returns the current entry and writes nothing', () => {
    wal.append(makeEntry({ id: 'a', status: 'pending' }));
    // the daemon acknowledged it before the caller got to update
    wal.updateEntry('a', { status: 'acked', ackedAt: new Date().toISOString() });
    const result = wal.updateEntryIf('a', (entry) => entry.status === 'pending' || entry.status === 'failed', { status: 'dlq' });
    expect(result).toMatchObject({ status: 'rejected', current: { id: 'a', status: 'acked' } });
    expect(wal.readAll()[0]!.status).toBe('acked');
  });

  it('says not-found for an unknown id', () => {
    expect(wal.updateEntryIf('nope', () => true, { status: 'dlq' })).toEqual({ status: 'not-found' });
  });

  it('evaluates the predicate on the file as it is when the lock is taken, not on an earlier read', () => {
    wal.append(makeEntry({ id: 'a', status: 'pending' }));
    const earlier = wal.readAll().find((entry) => entry.id === 'a')!;
    wal.updateEntry('a', { status: 'acked', ackedAt: new Date().toISOString() });
    // `earlier` still says pending; the predicate must see the acked state
    let seen: string | undefined;
    wal.updateEntryIf('a', (entry) => { seen = entry.status; return false; }, { status: 'dlq' });
    expect(earlier.status).toBe('pending');
    expect(seen).toBe('acked');
  });
});

describe('Wal.upsert', () => {
  it('appends an entry whose id is new', () => {
    wal.upsert(makeEntry({ id: 'a' }));
    expect(wal.readAll().map((entry) => entry.id)).toEqual(['a']);
  });

  it('replaces the entry with the same id instead of adding a second one (a replay must not leave two WAL entries with one id)', () => {
    wal.append(makeEntry({ id: 'a', status: 'dlq', attempts: 5 }));
    wal.append(makeEntry({ id: 'b' }));
    wal.upsert(makeEntry({ id: 'a', status: 'pending', attempts: 0 }));
    const all = wal.readAll();
    expect(all.filter((entry) => entry.id === 'a')).toHaveLength(1);
    expect(all.find((entry) => entry.id === 'a')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(all.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

describe('Wal.removeWhere', () => {
  it('removes the entries the predicate selects and returns them; the others stay', () => {
    wal.append(makeEntry({ id: 'a', status: 'dlq' }));
    wal.append(makeEntry({ id: 'b', status: 'pending' }));
    wal.append(makeEntry({ id: 'c', status: 'dlq' }));
    const removed = wal.removeWhere((entry) => entry.status === 'dlq');
    expect(removed.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(wal.readAll().map((entry) => entry.id)).toEqual(['b']);
  });

  it('removes nothing and returns an empty list when nothing matches', () => {
    wal.append(makeEntry({ id: 'a' }));
    expect(wal.removeWhere(() => false)).toEqual([]);
    expect(wal.readAll()).toHaveLength(1);
  });
});
