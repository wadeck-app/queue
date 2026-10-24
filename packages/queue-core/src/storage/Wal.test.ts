import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal } from './Wal.js';
import type { WalEntry } from './Wal.js';

function makeEntry(overrides: Partial<WalEntry> = {}): WalEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: 'test.event',
    payload: { x: 1 },
    meta: { cwd: '/tmp' },
    subscriberId: 'sub-1',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

describe('Wal', () => {
  let tmpDir: string;
  let wal: Wal;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wal-test-'));
    wal = new Wal(join(tmpDir, 'wal.ndjson'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append + readAll round-trip', () => {
    const entry = makeEntry();
    wal.append(entry);
    const all = wal.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entry);
  });

  it('atomic write: file is valid NDJSON after append', () => {
    const e1 = makeEntry({ id: 'id-1' });
    const e2 = makeEntry({ id: 'id-2' });
    wal.append(e1);
    wal.append(e2);
    const all = wal.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe('id-1');
    expect(all[1]!.id).toBe('id-2');
  });

  it('pendingCount returns correct count', () => {
    wal.append(makeEntry({ id: 'a', status: 'pending' }));
    wal.append(makeEntry({ id: 'b', status: 'acked' }));
    wal.append(makeEntry({ id: 'c', status: 'pending' }));
    expect(wal.pendingCount()).toBe(2);
  });

  it('updateEntry updates the right entry', () => {
    const e1 = makeEntry({ id: 'x' });
    const e2 = makeEntry({ id: 'y' });
    wal.append(e1);
    wal.append(e2);
    wal.updateEntry('x', { status: 'acked', ackedAt: new Date().toISOString() });
    const all = wal.readAll();
    expect(all.find(e => e.id === 'x')?.status).toBe('acked');
    expect(all.find(e => e.id === 'y')?.status).toBe('pending');
  });

  it('readAll returns empty array for non-existent file', () => {
    expect(wal.readAll()).toEqual([]);
  });
});

describe('Wal retention of acked entries', () => {
  const DAY = 24 * 3600_000;
  const NOW = Date.parse('2026-10-18T12:00:00.000Z');
  let tmpDir: string;
  let wal: Wal;
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wal-retention-'));
    wal = new Wal(join(tmpDir, 'wal.ndjson'), { now: () => NOW });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drops acked entries acknowledged more than 24 hours ago on the next append', () => {
    wal.append(makeEntry({ id: 'old', status: 'acked', ackedAt: ago(DAY + 1000) }));
    wal.append(makeEntry({ id: 'new' }));
    expect(wal.readAll().map(e => e.id)).toEqual(['new']);
  });

  it('keeps an acked entry that is less than 24 hours old', () => {
    wal.append(makeEntry({ id: 'recent', status: 'acked', ackedAt: ago(DAY - 60_000) }));
    wal.append(makeEntry({ id: 'new' }));
    expect(wal.readAll().map(e => e.id)).toEqual(['recent', 'new']);
  });

  it('drops them on an update too (a long-running daemon mostly updates)', () => {
    wal.append(makeEntry({ id: 'old', status: 'acked', ackedAt: ago(2 * DAY) }));
    wal.append(makeEntry({ id: 'p' }));
    wal.append(makeEntry({ id: 'old2', status: 'acked', ackedAt: ago(2 * DAY) }));
    wal.updateEntry('p', { attempts: 1 });
    expect(wal.readAll().map(e => e.id)).toEqual(['p']);
  });

  it('never drops pending, failed or dlq entries, however old', () => {
    for (const status of ['pending', 'failed', 'dlq'] as const) {
      wal.append(makeEntry({ id: status, status, timestamp: ago(30 * DAY) }));
    }
    wal.append(makeEntry({ id: 'trigger-prune' }));
    expect(wal.readAll().map(e => e.id)).toEqual(['pending', 'failed', 'dlq', 'trigger-prune']);
  });

  it('an acked entry without ackedAt ages from its creation time', () => {
    wal.append(makeEntry({ id: 'no-ackedAt', status: 'acked', timestamp: ago(3 * DAY) }));
    wal.append(makeEntry({ id: 'new' }));
    expect(wal.readAll().map(e => e.id)).toEqual(['new']);
  });
});
