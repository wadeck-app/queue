import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
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
    tmpDir = join(tmpdir(), `wal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
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
    wal.updateEntry('x', { status: 'acked', ackedAt: '2026-01-01T00:00:00.000Z' });
    const all = wal.readAll();
    expect(all.find(e => e.id === 'x')?.status).toBe('acked');
    expect(all.find(e => e.id === 'y')?.status).toBe('pending');
  });

  it('readAll returns empty array for non-existent file', () => {
    expect(wal.readAll()).toEqual([]);
  });
});
