import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, MAX_RETAINED_ACKED, type WalEntry } from './Wal.js';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

function entry(id: string, overrides: Partial<WalEntry> = {}): WalEntry {
  return { id, timestamp: new Date(NOW - 1000).toISOString(), event: 'onX', payload: { p: 1 }, meta: { cwd: '/tmp' }, subscriberId: 's', status: 'pending', attempts: 0, ...overrides };
}

// An acknowledged entry is only kept to refuse a retry of an id that was delivered; every write rewrites the whole file, so the count is bounded, not only the age
describe('Wal keeps a bounded number of acknowledged entries', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-scale-'));
    file = join(dir, 'wal.ndjson');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  const seedAcked = (count: number): void => {
    // acked id-0 is the oldest, id-(count-1) the newest, all within the age limit
    const lines = Array.from({ length: count }, (_, i) => JSON.stringify(entry(`acked-${i}`, { status: 'acked', ackedAt: new Date(NOW - (count - i) * 1000).toISOString() })));
    writeFileSync(file, lines.join('\n') + '\n');
  };

  it('an append drops the oldest acknowledged entries beyond the cap and keeps every pending, failed and dlq one', () => {
    const wal = new Wal(file, { now: () => NOW, maxRetainedAcked: 3 });
    writeFileSync(file, [
      ...Array.from({ length: 6 }, (_, i) => JSON.stringify(entry(`acked-${i}`, { status: 'acked', ackedAt: new Date(NOW - (6 - i) * 1000).toISOString() }))),
      JSON.stringify(entry('pend')), JSON.stringify(entry('fail', { status: 'failed' })), JSON.stringify(entry('dead', { status: 'dlq' })),
    ].join('\n') + '\n');

    wal.append(entry('new'));

    expect(wal.readAll().map((e) => e.id)).toEqual(['acked-3', 'acked-4', 'acked-5', 'pend', 'fail', 'dead', 'new']);
  });

  it('the cap is documented and applies by default', () => {
    expect(MAX_RETAINED_ACKED).toBeGreaterThan(0);
    seedAcked(MAX_RETAINED_ACKED + 50);
    const wal = new Wal(file, { now: () => NOW });
    wal.append(entry('new'));
    const acked = wal.readAll().filter((e) => e.status === 'acked');
    expect(acked).toHaveLength(MAX_RETAINED_ACKED);
    // the newest ones survive
    expect(acked.at(-1)!.id).toBe(`acked-${MAX_RETAINED_ACKED + 49}`);
  });

  it('an update of an id that is not in the file does not rewrite it', () => {
    seedAcked(MAX_RETAINED_ACKED + 5);
    const before = readFileSync(file, 'utf-8');
    new Wal(file, { now: () => NOW }).updateEntry('unknown', { attempts: 9 });
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('an update of a known id still rewrites and compacts', () => {
    seedAcked(MAX_RETAINED_ACKED + 5);
    const wal = new Wal(file, { now: () => NOW });
    wal.append(entry('p'));
    wal.updateEntry('p', { attempts: 2 });
    expect(wal.readAll().find((e) => e.id === 'p')!.attempts).toBe(2);
    expect(wal.readAll().filter((e) => e.status === 'acked')).toHaveLength(MAX_RETAINED_ACKED);
  });
});
