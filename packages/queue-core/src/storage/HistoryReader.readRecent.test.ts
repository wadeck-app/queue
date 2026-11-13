import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader, type HistoryEntry } from './HistoryReader.js';

let historyDir: string;

beforeEach(() => {
  historyDir = join(tmpdir(), `queue-history-read-recent-${crypto.randomUUID()}`);
  mkdirSync(historyDir, { recursive: true });
});

afterEach(() => {
  rmSync(historyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function writeDay(date: string, records: object[]): void {
  writeFileSync(join(historyDir, `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const trigger = (day: string, eventId: string, event = 'onA', extra: object = {}): object => ({ ts: `${day}T10:00:00.000Z`, type: 'trigger', eventId, event, matchedCount: 1, totalCount: 1, ...extra });
const outcome = (day: string, eventId: string, event = 'onA'): object => ({ ts: `${day}T10:00:01.000Z`, type: 'outcome', eventId, event, subscriberId: 's', status: 'success' });

const SINCE = Date.parse('2026-01-05T00:00:00.000Z');

describe('HistoryReader.readRecent', () => {
  it('returns what read() returns for the same event and since, on a history of several days with other events and outcomes', () => {
    writeDay('2026-01-01', [trigger('2026-01-01', 'old-1'), outcome('2026-01-01', 'old-1')]);
    writeDay('2026-01-04', [trigger('2026-01-04', 'edge-1'), trigger('2026-01-04', 'other-1', 'onB')]);
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1', 'onA', { payload: { n: 1 } }), outcome('2026-01-05', 'a-1'), trigger('2026-01-05', 'b-1', 'onB'), outcome('2026-01-05', 'b-1', 'onB')]);
    writeDay('2026-01-06', [trigger('2026-01-06', 'a-2'), { ts: '2026-01-06T10:00:02.000Z', type: 'filtered', eventId: 'a-2', event: 'onA', subscriberId: 'f', filter: 'x', actual: 'y' }]);

    const reader = new HistoryReader(historyDir);

    const recent = reader.readRecent({ event: 'onA', sinceMs: SINCE });

    expect(recent).toEqual(new HistoryReader(historyDir).read({ event: 'onA', sinceMs: SINCE }));
    expect(recent.map((e) => e.eventId)).toEqual(['a-2', 'a-1']);
  });

  it('returns what read() returns for a predicate on the name (a pattern), without the other names', () => {
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1', 'dep.a'), trigger('2026-01-05', 'b-1', 'dep.b'), trigger('2026-01-05', 'c-1', 'other.c')]);
    const matchEvent = (name: string): boolean => name.startsWith('dep.');

    const recent = new HistoryReader(historyDir).readRecent({ match: { key: 'dep.*', test: matchEvent }, sinceMs: SINCE });

    expect(recent.map((e) => e.eventId).sort()).toEqual(['a-1', 'b-1']);
    expect(recent).toEqual(new HistoryReader(historyDir).read({ sinceMs: SINCE }).filter((e) => matchEvent(e.event)));
  });

  it('opens only the day files that can hold the window: a file of an earlier day (here a directory, which cannot be read) is never touched', () => {
    mkdirSync(join(historyDir, '2025-12-01.ndjson'));
    mkdirSync(join(historyDir, '2026-01-02.ndjson'));
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1')]);

    const reader = new HistoryReader(historyDir);

    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE }).map((e) => e.eventId)).toEqual(['a-1']);
  });

  it('reads the day before the window too (a record is filed under the UTC day of its time, and a push just before midnight lands in the previous file)', () => {
    writeDay('2026-01-04', [{ ts: '2026-01-04T23:59:59.000Z', type: 'trigger', eventId: 'late', event: 'onA', matchedCount: 0, totalCount: 0 }]);
    writeDay('2026-01-05', [outcome('2026-01-05', 'late')]);

    const entries = new HistoryReader(historyDir).readRecent({ event: 'onA', sinceMs: Date.parse('2026-01-04T23:59:00.000Z') });

    expect(entries.map((e) => [e.eventId, e.subscribers.length])).toEqual([['late', 1]]);
  });

  it('leaves out the late outcome of a push older than the window, as read() does (its trigger sits in a file that was not opened)', () => {
    writeDay('2026-01-01', [trigger('2026-01-01', 'old-1')]);
    writeDay('2026-01-05', [outcome('2026-01-05', 'old-1'), trigger('2026-01-05', 'a-1')]);

    const recent = new HistoryReader(historyDir).readRecent({ event: 'onA', sinceMs: SINCE });

    expect(recent.map((e) => e.eventId)).toEqual(['a-1']);
    expect(recent).toEqual(new HistoryReader(historyDir).read({ event: 'onA', sinceMs: SINCE }));
  });

  it('keeps an outcome-only entry (a retry) whose trigger is nowhere, as read() does', () => {
    writeDay('2026-01-05', [outcome('2026-01-05', 'wal-1')]);

    const recent = new HistoryReader(historyDir).readRecent({ event: 'onA', sinceMs: SINCE });

    expect(recent.map((e) => [e.eventId, e.orphan])).toEqual([['wal-1', true]]);
  });

  it('keeps only the records of the wanted event in memory: lines of other events are never parsed (a torn one is not even noticed)', () => {
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1')]);
    appendFileSync(join(historyDir, '2026-01-05.ndjson'), '{"ts":"2026-01-05T10:00:00.000Z","type":"trigger","eventId":"b-1","event":"onB","payload":{"cut\n');
    const reader = new HistoryReader(historyDir);

    const entries = reader.readRecent({ event: 'onA', sinceMs: SINCE });

    expect(entries.map((e) => e.eventId)).toEqual(['a-1']);
    expect(reader.malformedLines()).toEqual([]);
  });

  it('picks up what is appended between two reads, and only reads the new bytes (the first line is not parsed again)', () => {
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1')]);
    const reader = new HistoryReader(historyDir);
    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE }).map((e) => e.eventId)).toEqual(['a-1']);

    appendFileSync(join(historyDir, '2026-01-05.ndjson'), JSON.stringify(trigger('2026-01-05', 'a-2')) + '\n');
    appendFileSync(join(historyDir, '2026-01-05.ndjson'), JSON.stringify(outcome('2026-01-05', 'a-1')) + '\n');
    const second = reader.readRecent({ event: 'onA', sinceMs: SINCE });

    expect(second.map((e) => e.eventId).sort()).toEqual(['a-1', 'a-2']);
    expect(second.find((e) => e.eventId === 'a-1')!.subscribers).toHaveLength(1);
  });

  it('reads a last record that has no trailing newline, and a record that appears complete later', () => {
    const file = join(historyDir, '2026-01-05.ndjson');
    writeFileSync(file, JSON.stringify(trigger('2026-01-05', 'a-1')), 'utf-8');
    const reader = new HistoryReader(historyDir);
    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE }).map((e) => e.eventId)).toEqual(['a-1']);

    appendFileSync(file, '\n' + JSON.stringify(trigger('2026-01-05', 'a-2')) + '\n');

    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE }).map((e) => e.eventId).sort()).toEqual(['a-1', 'a-2']);
  });

  it('starts again when a day file was replaced by a shorter one', () => {
    writeDay('2026-01-05', [trigger('2026-01-05', 'a-1'), trigger('2026-01-05', 'a-2')]);
    const reader = new HistoryReader(historyDir);
    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE })).toHaveLength(2);

    writeDay('2026-01-05', [trigger('2026-01-05', 'a-3')]);

    expect(reader.readRecent({ event: 'onA', sinceMs: SINCE }).map((e) => e.eventId)).toEqual(['a-3']);
  });

  it('reads a file far bigger than one chunk, with multibyte text cut by chunk borders and lines longer than a chunk', () => {
    const filler = Array.from({ length: 400 }, (_, i) => trigger('2026-01-05', `x-${i}`, 'onB', { payload: { text: 'é€'.repeat(2000) } }));
    const huge = trigger('2026-01-05', 'a-big', 'onA', { payload: { text: 'é'.repeat(1_500_000) } });
    writeDay('2026-01-05', [...filler.slice(0, 200), huge, ...filler.slice(200), trigger('2026-01-05', 'a-last')]);

    const entries = new HistoryReader(historyDir).readRecent({ event: 'onA', sinceMs: SINCE });

    expect(entries.map((e) => e.eventId).sort()).toEqual(['a-big', 'a-last']);
    expect(((entries.find((e) => e.eventId === 'a-big') as HistoryEntry).payload as { text: string }).text).toHaveLength(1_500_000);
  });

  it('is empty for a missing directory', () => {
    expect(new HistoryReader(join(historyDir, 'nope')).readRecent({ event: 'onA', sinceMs: SINCE })).toEqual([]);
  });
});

describe('HistoryReader.eventActivity (streamed)', () => {
  it('counts the same on a file bigger than one chunk, with a line longer than a chunk', () => {
    const records = [
      ...Array.from({ length: 300 }, (_, i) => trigger('2026-01-05', `x-${i}`, 'onB', { payload: { text: 'é€'.repeat(3000) } })),
      trigger('2026-01-05', 'big', 'onA', { payload: { text: 'é'.repeat(1_500_000) } }),
      trigger('2026-01-05', 'a-1'),
    ];
    writeDay('2026-01-05', records);

    const activity = new HistoryReader(historyDir).eventActivity(Date.parse('2026-01-05T23:00:00.000Z'), 86_400_000, 86_400_000);

    expect(activity.get('onA')?.count).toBe(2);
    expect(activity.get('onB')?.count).toBe(300);
  });
});
