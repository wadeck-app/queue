import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal } from './storage/Wal.js';
import { DlqStore } from './storage/DlqStore.js';
import { readQueueCounts, listInFlightEntries, listDlqEntries, clearDlqEntries, listQueueSubscribers, abandonInFlightEntry, abandonStuckEntries, countStuckEntries } from './operations.js';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-ops-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-ops-project-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const meta = { cwd: '/p', projectName: 'p' };

function walEntry(id: string, status: 'pending' | 'acked' | 'failed' | 'dlq') {
  return { id, timestamp: new Date().toISOString(), ackedAt: new Date().toISOString(), event: 'onFoo', payload: {}, meta, subscriberId: 's', status, attempts: 0 };
}

function dlqEntry(id: string) {
  return { id, event: 'onFoo', payload: { id }, meta, subscriberId: 's', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() };
}

describe('readQueueCounts', () => {
  it('is zero for a config dir that has no WAL or DLQ yet', () => {
    expect(readQueueCounts(configDir)).toEqual({ pendingCount: 0, dlqCount: 0 });
  });

  it('counts the pending WAL entries and the DLQ entries from the files, without any daemon', () => {
    const wal = new Wal(join(configDir, 'wal.ndjson'));
    wal.append(walEntry('a', 'pending'));
    wal.append(walEntry('b', 'pending'));
    wal.append(walEntry('c', 'acked'));
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('x'));
    expect(readQueueCounts(configDir)).toEqual({ pendingCount: 2, dlqCount: 1 });
  });
});

describe('listDlqEntries / clearDlqEntries', () => {
  beforeEach(() => {
    const dlq = new DlqStore(join(configDir, 'dlq.ndjson'));
    dlq.append(dlqEntry('x'));
    dlq.append(dlqEntry('y'));
  });

  it('lists the entries', () => {
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['x', 'y']);
  });

  it('clears one entry by id and reports 1', () => {
    expect(clearDlqEntries(configDir, 'x')).toBe(1);
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['y']);
  });

  it('clears everything when no id is given and reports how many', () => {
    expect(clearDlqEntries(configDir)).toBe(2);
    expect(listDlqEntries(configDir)).toEqual([]);
  });
});

describe('listQueueSubscribers', () => {
  function writeProjectSubscribers(content: string): void {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), content);
  }

  it('lists every subscriber configured for the project', () => {
    writeProjectSubscribers('subscribers:\n  onA:\n    - type: cli\n      command: echo a\n  onB:\n    - type: cli\n      command: echo b\n');
    expect(listQueueSubscribers(configDir, { cwd: projectDir }).map(s => s.event).sort()).toEqual(['onA', 'onB']);
  });

  it('filters to the subscribers matching one event', () => {
    writeProjectSubscribers('subscribers:\n  onA:\n    - type: cli\n      command: echo a\n  onB:\n    - type: cli\n      command: echo b\n');
    expect(listQueueSubscribers(configDir, { cwd: projectDir, event: 'onB' }).map(s => s.event)).toEqual(['onB']);
  });

  it('lets an invalid subscribers.yml surface as an error (never an empty list)', () => {
    writeProjectSubscribers('subscribers: [this is not valid\n');
    expect(() => listQueueSubscribers(configDir, { cwd: projectDir })).toThrow();
  });
});

describe('clearDlqEntries with an unknown id', () => {
  it('reports 0 instead of pretending something was cleared', () => {
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('x'));
    expect(clearDlqEntries(configDir, 'nope')).toBe(0);
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['x']);
  });
});

describe('listInFlightEntries', () => {
  it('lists the events still on their way (pending and failed), oldest first, and leaves out the finished ones', () => {
    const wal = new Wal(join(configDir, 'wal.ndjson'));
    wal.append(walEntry('p1', 'pending'));
    wal.append(walEntry('a1', 'acked'));
    wal.append(walEntry('f1', 'failed'));
    wal.append(walEntry('d1', 'dlq'));
    wal.append(walEntry('p2', 'pending'));
    expect(listInFlightEntries(configDir).map((entry) => entry.id)).toEqual(['p1', 'f1', 'p2']);
  });

  it('is empty without a WAL file', () => {
    expect(listInFlightEntries(configDir)).toEqual([]);
  });
});

describe('abandonInFlightEntry (give up an event that will never be retried, without losing it)', () => {
  const dlqPath = (): string => join(configDir, 'dlq.ndjson');

  it('moves a failed entry to the DLQ with its payload, subscriber and attempts, and says it was given up by hand', () => {
    new Wal(join(configDir, 'wal.ndjson')).append({ ...walEntry('f1', 'failed'), payload: { a: 1 }, attempts: 2, lastError: 'exited with code 3' });
    expect(abandonInFlightEntry(configDir, 'f1', new Date('2026-10-24T12:00:00.000Z'))).toEqual({ status: 'moved' });
    const [moved] = new DlqStore(dlqPath()).readAll();
    expect(moved).toMatchObject({ id: 'f1', event: 'onFoo', payload: { a: 1 }, subscriberId: 's', attempts: 2, movedAt: '2026-10-24T12:00:00.000Z' });
    expect(moved?.lastError).toBe('exited with code 3 (given up by hand)');
  });

  it('moves a pending entry that was never tried, with a reason that says so', () => {
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('p1', 'pending'));
    expect(abandonInFlightEntry(configDir, 'p1')).toEqual({ status: 'moved' });
    expect(new DlqStore(dlqPath()).readAll()[0]?.lastError).toBe('given up by hand before any attempt');
  });

  it('the entry is no longer in flight, it is in the DLQ where it can be replayed or cleared', () => {
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('f1', 'failed'));
    abandonInFlightEntry(configDir, 'f1');
    expect(listInFlightEntries(configDir)).toEqual([]);
    expect(listDlqEntries(configDir).map((entry) => entry.id)).toEqual(['f1']);
    expect(readQueueCounts(configDir)).toEqual({ pendingCount: 0, dlqCount: 1 });
  });

  it('leaves the other entries alone', () => {
    const wal = new Wal(join(configDir, 'wal.ndjson'));
    wal.append(walEntry('f1', 'failed'));
    wal.append(walEntry('f2', 'failed'));
    abandonInFlightEntry(configDir, 'f1');
    expect(listInFlightEntries(configDir).map((entry) => entry.id)).toEqual(['f2']);
  });

  it('answers not-found for an id the WAL does not know, and changes nothing', () => {
    expect(abandonInFlightEntry(configDir, 'nope')).toEqual({ status: 'not-found' });
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it.each(['acked', 'dlq'] as const)('answers not-in-flight for an entry that is already %s, and does not duplicate it in the DLQ', (status) => {
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('x', status));
    expect(abandonInFlightEntry(configDir, 'x')).toEqual({ status: 'not-in-flight' });
    expect(listDlqEntries(configDir)).toEqual([]);
  });

  it('does not move the same entry twice', () => {
    new Wal(join(configDir, 'wal.ndjson')).append(walEntry('f1', 'failed'));
    abandonInFlightEntry(configDir, 'f1');
    expect(abandonInFlightEntry(configDir, 'f1')).toEqual({ status: 'not-in-flight' });
    expect(listDlqEntries(configDir)).toHaveLength(1);
  });
});

describe('abandonStuckEntries (the in-flight events that waited so long nobody will retry them)', () => {
  const NOW = new Date('2026-10-24T12:00:00.000Z');
  const old = (id: string, status: 'pending' | 'failed', hoursAgo: number) => ({ ...walEntry(id, status), timestamp: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });

  it('moves every pending or failed entry older than the limit (2 hours by default) to the DLQ, and only those', () => {
    const wal = new Wal(join(configDir, 'wal.ndjson'));
    wal.append(old('stuck-failed', 'failed', 30));
    wal.append(old('stuck-pending', 'pending', 5));
    wal.append(old('recent-failed', 'failed', 0.5));
    wal.append({ ...old('delivered', 'failed', 40), status: 'acked' });
    expect(abandonStuckEntries(configDir, { now: NOW })).toEqual({ moved: 2 });
    expect(listInFlightEntries(configDir).map((entry) => entry.id)).toEqual(['recent-failed']);
    expect(listDlqEntries(configDir).map((entry) => entry.id).sort()).toEqual(['stuck-failed', 'stuck-pending']);
  });

  it('takes the limit it is given', () => {
    new Wal(join(configDir, 'wal.ndjson')).append(old('f', 'failed', 3));
    expect(abandonStuckEntries(configDir, { now: NOW, olderThanMs: 4 * 3_600_000 })).toEqual({ moved: 0 });
    expect(abandonStuckEntries(configDir, { now: NOW, olderThanMs: 1 * 3_600_000 })).toEqual({ moved: 1 });
  });

  it('counts them without moving anything when asked to', () => {
    new Wal(join(configDir, 'wal.ndjson')).append(old('f', 'failed', 30));
    expect(countStuckEntries(configDir, { now: NOW })).toBe(1);
    expect(listInFlightEntries(configDir)).toHaveLength(1);
  });

  it('is zero for a queue with nothing in flight', () => {
    expect(abandonStuckEntries(configDir, { now: NOW })).toEqual({ moved: 0 });
    expect(countStuckEntries(configDir, { now: NOW })).toBe(0);
  });
});
