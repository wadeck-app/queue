import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal } from './storage/Wal.js';
import type { WalEntry } from './storage/Wal.js';
import { DlqStore } from './storage/DlqStore.js';
import type { DlqEntry } from './storage/DlqStore.js';
import { abandonInFlightEntryDetailed, abandonStuckEntriesDetailed, clearDlqEntries, clearDlqEntriesReturning, listDlqEntries, pruneOrphanedDlqWalEntries, removeDlqEntries } from './operations.js';
import { dlqEntry as baseDlqEntry, walEntry as baseWalEntry } from './queueEntries.testUtil.js';

// Item 4: the give-up is a compare-and-set on the WAL (no acked -> dlq with a row in the DLQ). Item 5: the WAL does not keep the payload of a row that left the DLQ.

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-ops-safety-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

const meta = { cwd: '/p', projectName: 'p' };
const wal = (): Wal => new Wal(join(configDir, 'wal.ndjson'));
const dlq = (): DlqStore => new DlqStore(join(configDir, 'dlq.ndjson'));

const walEntry = (id: string, status: WalEntry['status'], overrides: Partial<WalEntry> = {}): WalEntry => baseWalEntry(id, { event: 'onFoo', payload: { secret: `S3CRET-${id}` }, meta, status, attempts: 1, ...overrides });

const dlqEntry = (id: string, overrides: Partial<DlqEntry> = {}): DlqEntry => baseDlqEntry(id, { event: 'onFoo', payload: { secret: `S3CRET-${id}` }, meta, attempts: 3, ...overrides });

const walFileText = (): string => (existsSync(join(configDir, 'wal.ndjson')) ? readFileSync(join(configDir, 'wal.ndjson'), 'utf8') : '');

describe('give-up is a compare-and-set (item 4)', () => {
  it('an ack that lands before the update wins: not-in-flight, the DLQ is not touched, the entry stays acked', () => {
    wal().append(walEntry('p1', 'pending'));
    // The interleaving: the daemon acknowledges the delivery between the moment the caller looked at the entry and the moment it updates it
    const original = Wal.prototype.updateEntryIf;
    vi.spyOn(Wal.prototype, 'updateEntryIf').mockImplementation(function (this: Wal, ...args: Parameters<Wal['updateEntryIf']>) {
      new Wal(join(configDir, 'wal.ndjson')).updateEntry('p1', { status: 'acked', ackedAt: new Date().toISOString() });
      return original.apply(this, args);
    });
    expect(abandonInFlightEntryDetailed(configDir, 'p1')).toEqual({ status: 'not-in-flight' });
    expect(listDlqEntries(configDir)).toEqual([]);
    expect(wal().readAll()[0]!.status).toBe('acked');
  });

  it('the DLQ row is built from the entry as it is under the lock (a failure recorded meanwhile is in the row)', () => {
    wal().append(walEntry('f1', 'failed', { attempts: 1, lastError: 'first' }));
    const original = Wal.prototype.updateEntryIf;
    vi.spyOn(Wal.prototype, 'updateEntryIf').mockImplementation(function (this: Wal, ...args: Parameters<Wal['updateEntryIf']>) {
      new Wal(join(configDir, 'wal.ndjson')).updateEntry('f1', { attempts: 4, lastError: 'fourth failure' });
      return original.apply(this, args);
    });
    expect(abandonInFlightEntryDetailed(configDir, 'f1').status).toBe('moved');
    expect(listDlqEntries(configDir)[0]).toMatchObject({ id: 'f1', attempts: 4, lastError: 'fourth failure (given up by hand)' });
  });

  it('when the DLQ write fails the status goes back to what it was and the error is not swallowed', () => {
    wal().append(walEntry('f1', 'failed'));
    vi.spyOn(DlqStore.prototype, 'append').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => abandonInFlightEntryDetailed(configDir, 'f1')).toThrow('disk full');
    expect(wal().readAll()[0]!.status).toBe('failed');
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('an entry still pending or failed moves exactly once even when asked twice', () => {
    wal().append(walEntry('f1', 'failed'));
    expect(abandonInFlightEntryDetailed(configDir, 'f1').status).toBe('moved');
    expect(abandonInFlightEntryDetailed(configDir, 'f1')).toEqual({ status: 'not-in-flight' });
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });

  it('with the announce option the row is written marked pending, with the facts needed to emit later; without it the row has no mark', () => {
    wal().append(walEntry('a', 'failed'));
    wal().append(walEntry('b', 'failed'));
    abandonInFlightEntryDetailed(configDir, 'a', new Date(), { markAnnouncePending: true });
    abandonInFlightEntryDetailed(configDir, 'b');
    expect(listDlqEntries(configDir).find((row) => row.id === 'a')).toMatchObject({ announce: 'pending', announceInfo: { reason: 'given-up' } });
    expect(listDlqEntries(configDir).find((row) => row.id === 'b')).not.toHaveProperty('announce');
  });
});

describe('the WAL does not keep the payload of a row that left the DLQ for good (item 5)', () => {
  it('clear of one entry and of all removes the WAL entry that carried the payload', () => {
    wal().append(walEntry('a', 'dlq'));
    wal().append(walEntry('b', 'dlq'));
    wal().append(walEntry('c', 'dlq'));
    for (const id of ['a', 'b', 'c']) {
      dlq().append(dlqEntry(id));
    }
    expect(clearDlqEntries(configDir, 'a')).toBe(1);
    expect(walFileText()).not.toContain('S3CRET-a');
    expect(walFileText()).toContain('S3CRET-b');
    expect(clearDlqEntriesReturning(configDir).map((row) => row.id)).toEqual(['b', 'c']);
    expect(walFileText()).not.toContain('S3CRET');
    expect(wal().readAll()).toEqual([]);
  });

  it('leaves a WAL entry that is not in status dlq (a replayed entry runs again under the same id)', () => {
    wal().append(walEntry('a', 'pending'));
    dlq().append(dlqEntry('a'));
    clearDlqEntries(configDir, 'a');
    expect(wal().readAll().map((entry) => entry.id)).toEqual(['a']);
  });

  it('the cap eviction of a give-up removes the evicted row WAL entry too', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`e${i}`))).join('\n') + '\n');
    wal().append(walEntry('e0', 'dlq'));
    wal().append(walEntry('late', 'failed'));
    const moved = abandonInFlightEntryDetailed(configDir, 'late');
    expect((moved as Extract<typeof moved, { status: 'moved' }>).changes.evicted.map((row) => row.id)).toEqual(['e0']);
    expect(walFileText()).not.toContain('S3CRET-e0');
  });

  it('stuck entries given up while the cap is full also purge the evicted ones', () => {
    writeFileSync(join(configDir, 'dlq.ndjson'), Array.from({ length: 1000 }, (_, i) => JSON.stringify(dlqEntry(`e${i}`))).join('\n') + '\n');
    wal().append(walEntry('e0', 'dlq'));
    wal().append(walEntry('old', 'failed', { timestamp: '2020-01-01T00:00:00.000Z' }));
    expect(abandonStuckEntriesDetailed(configDir).moved).toBe(1);
    expect(walFileText()).not.toContain('S3CRET-e0');
  });
});

describe('pruneOrphanedDlqWalEntries (a dlq-status WAL entry no DLQ row refers to, older than a day)', () => {
  const NOW = new Date('2026-11-07T12:00:00.000Z');
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  const DAY = 24 * 3_600_000;

  it('removes the orphans older than a day and keeps the rest', () => {
    wal().append(walEntry('orphan-old', 'dlq', { timestamp: ago(2 * DAY) }));
    wal().append(walEntry('orphan-young', 'dlq', { timestamp: ago(DAY / 2) }));
    wal().append(walEntry('has-row', 'dlq', { timestamp: ago(30 * DAY) }));
    wal().append(walEntry('pending-old', 'pending', { timestamp: ago(30 * DAY) }));
    dlq().append(dlqEntry('has-row'));
    expect(pruneOrphanedDlqWalEntries(configDir, { now: NOW })).toEqual({ pruned: 1 });
    expect(wal().readAll().map((entry) => entry.id)).toEqual(['orphan-young', 'has-row', 'pending-old']);
    expect(walFileText()).not.toContain('S3CRET-orphan-old');
  });

  it('is a no-op on a config dir without files', () => {
    expect(pruneOrphanedDlqWalEntries(configDir, { now: NOW })).toEqual({ pruned: 0 });
  });
});

describe('an empty id is invalid, never "everything"', () => {
  it('clearDlqEntries / clearDlqEntriesReturning / removeDlqEntries refuse an empty id and clear nothing; an absent id clears all', () => {
    for (const id of ['a', 'b']) {
      wal().append(walEntry(id, 'dlq'));
      dlq().append(dlqEntry(id));
    }
    expect(() => clearDlqEntries(configDir, '')).toThrow(/empty.*id.*omit the id/i);
    expect(() => clearDlqEntriesReturning(configDir, '')).toThrow(/empty.*id/i);
    expect(() => removeDlqEntries(dlq(), wal(), '')).toThrow(/empty.*id/i);
    expect(listDlqEntries(configDir).map((row) => row.id)).toEqual(['a', 'b']);
    expect(wal().readAll()).toHaveLength(2);
    // the explicit way to clear everything is no id at all
    expect(clearDlqEntries(configDir, undefined)).toBe(2);
    expect(listDlqEntries(configDir)).toEqual([]);
  });
});
