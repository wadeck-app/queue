import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader } from './HistoryReader.js';
import { HistoryLog } from './HistoryLog.js';

function writeDay(historyDir: string, date: string, records: object[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(historyDir, `${date}.ndjson`), content, 'utf-8');
}

describe('HistoryReader', () => {
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-reader-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  it('returns empty array when the history directory does not exist', () => {
    const reader = new HistoryReader(join(historyDir, 'missing'));
    expect(reader.read()).toEqual([]);
  });

  it('groups trigger, outcome and filtered records by eventId', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onTicket.created', project: 'queue', matchedCount: 1, totalCount: 2 },
      { ts: '2026-01-01T10:00:00.100Z', type: 'filtered', eventId: 'ev-1', event: 'onTicket.created', subscriberId: 'onTicket.created[1]', filter: 'payload.exitCode=0', actual: '1' },
      { ts: '2026-01-01T10:00:00.200Z', type: 'outcome', eventId: 'ev-1', event: 'onTicket.created', subscriberId: 'onTicket.created[0]', status: 'success', target: 'echo ok' },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry).toMatchObject({
      eventId: 'ev-1',
      event: 'onTicket.created',
      project: 'queue',
      matchedCount: 1,
      totalCount: 2,
      orphan: false,
    });
    expect(entry!.subscribers).toEqual(
      expect.arrayContaining([
        { subscriberId: 'onTicket.created[0]', status: 'success', target: 'echo ok' },
        { subscriberId: 'onTicket.created[1]', status: 'filtered', filter: 'payload.exitCode=0', actual: '1' },
      ]),
    );
  });

  it('marks an event with zero matching subscribers as a trigger-only entry', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'unconfigured.event', matchedCount: 0, totalCount: 0 },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry).toMatchObject({ eventId: 'ev-2', event: 'unconfigured.event', matchedCount: 0, totalCount: 0, orphan: false });
    expect(entry!.subscribers).toEqual([]);
  });

  it('reads the payload and replayOf recorded on the trigger, for queue replay', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onTicket.created', matchedCount: 0, totalCount: 0, payload: { title: 'original' }, replayOf: 'ev-0' },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry).toMatchObject({ payload: { title: 'original' }, replayOf: 'ev-0' });
  });

  it('reads the cwd recorded on the trigger, so replay reuses the original push cwd', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onTicket.created', matchedCount: 0, totalCount: 0, cwd: '/home/user/project' },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry).toMatchObject({ cwd: '/home/user/project' });
  });

  it('leaves cwd undefined for older trigger records without it', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onTicket.created', matchedCount: 0, totalCount: 0 },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry.cwd).toBeUndefined();
  });

  it('leaves cwd undefined for orphan entries', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'outcome', eventId: 'wal-1', event: 'onTicket.created', subscriberId: 'onTicket.created[0]', status: 'success' },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry.cwd).toBeUndefined();
  });

  describe('findByEventId', () => {
    it('returns the entry with the matching eventId', () => {
      writeDay(historyDir, '2026-01-01', [
        { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0, payload: { a: 1 } },
        { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0, payload: { b: 2 } },
      ]);

      const entry = new HistoryReader(historyDir).findByEventId('ev-2');
      expect(entry).toMatchObject({ eventId: 'ev-2', event: 'onB', payload: { b: 2 } });
    });

    it('returns undefined when no entry matches', () => {
      writeDay(historyDir, '2026-01-01', [
        { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
      ]);

      expect(new HistoryReader(historyDir).findByEventId('does-not-exist')).toBeUndefined();
    });
  });

  it('marks outcome/filtered records with no matching trigger as orphan, instead of dropping them', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'outcome', eventId: 'wal-1', event: 'onTicket.created', subscriberId: 'onTicket.created[0]', status: 'success' },
    ]);

    const [entry] = new HistoryReader(historyDir).read();
    expect(entry).toMatchObject({ eventId: 'wal-1', event: 'onTicket.created', orphan: true });
    expect(entry!.totalCount).toBeUndefined();
  });

  it('reads across multiple day files', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
    ]);
    writeDay(historyDir, '2026-01-02', [
      { ts: '2026-01-02T10:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
    ]);

    const entries = new HistoryReader(historyDir).read();
    expect(entries.map(e => e.event).sort()).toEqual(['onA', 'onB']);
  });

  it('sorts newest first', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
    ]);

    const entries = new HistoryReader(historyDir).read();
    expect(entries.map(e => e.eventId)).toEqual(['ev-2', 'ev-1']);
  });

  it('filters by event name', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
    ]);

    const entries = new HistoryReader(historyDir).read({ event: 'onB' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('onB');
  });

  it('filters by subscriberId', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1 },
      { ts: '2026-01-01T10:00:00.100Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 'onA[0]', status: 'success' },
      { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 1, totalCount: 1 },
      { ts: '2026-01-01T11:00:00.100Z', type: 'outcome', eventId: 'ev-2', event: 'onB', subscriberId: 'onB[0]', status: 'success' },
    ]);

    const entries = new HistoryReader(historyDir).read({ subscriberId: 'onB[0]' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventId).toBe('ev-2');
  });

  it('filters by status, including "filtered"', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 2 },
      { ts: '2026-01-01T10:00:00.100Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 'onA[0]', status: 'success' },
      { ts: '2026-01-01T10:00:00.200Z', type: 'filtered', eventId: 'ev-1', event: 'onA', subscriberId: 'onA[1]' },
    ]);

    expect(new HistoryReader(historyDir).read({ status: 'filtered' })).toHaveLength(1);
    expect(new HistoryReader(historyDir).read({ status: 'dlq' })).toHaveLength(0);
  });

  it('filters by sinceMs cutoff', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T12:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
    ]);

    const entries = new HistoryReader(historyDir).read({ sinceMs: Date.parse('2026-01-01T11:00:00.000Z') });
    expect(entries.map(e => e.eventId)).toEqual(['ev-2']);
  });

  it('throws on a malformed record instead of silently skipping it', () => {
    writeFileSync(join(historyDir, '2026-01-01.ndjson'), 'not json\n', 'utf-8');
    expect(() => new HistoryReader(historyDir).read()).toThrow(/Malformed history record/);
  });

  describe('per-file caching (queue history --follow polls the same reader repeatedly)', () => {
    it('serves a file from cache when its mtime is unchanged, instead of re-parsing it', () => {
      const filePath = join(historyDir, '2026-01-01.ndjson');
      writeDay(historyDir, '2026-01-01', [
        { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
      ]);
      const originalMtime = statSync(filePath).mtime;

      const reader = new HistoryReader(historyDir);
      reader.read();

      // Corrupt the file without touching mtime: if read() re-parsed it, this would throw.
      writeFileSync(filePath, 'not json\n', 'utf-8');
      utimesSync(filePath, originalMtime, originalMtime);

      expect(() => reader.read()).not.toThrow();
      expect(reader.read()[0]).toMatchObject({ eventId: 'ev-1' });
    });

    it('re-reads a file once its mtime changes', () => {
      const filePath = join(historyDir, '2026-01-01.ndjson');
      writeDay(historyDir, '2026-01-01', [
        { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1 },
      ]);

      const reader = new HistoryReader(historyDir);
      const [before] = reader.read();
      expect(before!.subscribers).toEqual([]);

      writeFileSync(
        filePath,
        JSON.stringify({ ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1 }) + '\n' +
        JSON.stringify({ ts: '2026-01-01T10:00:00.100Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 'onA[0]', status: 'success' }) + '\n',
        'utf-8',
      );
      const future = new Date(Date.now() + 60_000);
      utimesSync(filePath, future, future);

      const [after] = reader.read();
      expect(after!.subscribers).toHaveLength(1);
    });
  });

  describe('readPage', () => {
    function writeMany(count: number): void {
      const records = Array.from({ length: count }, (_, i) => ({
        ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        type: 'trigger',
        eventId: `ev-${i}`,
        event: 'onA',
        matchedCount: 0,
        totalCount: 0,
      }));
      writeDay(historyDir, '2026-01-01', records);
    }

    it('defaults to the first 20 entries, newest first', () => {
      writeMany(25);
      const page = new HistoryReader(historyDir).readPage();
      expect(page.entries).toHaveLength(20);
      expect(page.total).toBe(25);
      expect(page.limit).toBe(20);
      expect(page.offset).toBe(0);
      expect(page.entries[0]!.eventId).toBe('ev-24');
    });

    it('respects explicit limit/offset', () => {
      writeMany(25);
      const page = new HistoryReader(historyDir).readPage({}, { limit: 5, offset: 20 });
      expect(page.entries).toHaveLength(5);
      expect(page.total).toBe(25);
      expect(page.entries.map(e => e.eventId)).toEqual(['ev-4', 'ev-3', 'ev-2', 'ev-1', 'ev-0']);
    });

    it('applies the filter before paginating', () => {
      writeDay(historyDir, '2026-01-01', [
        { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 0, totalCount: 0 },
        { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
      ]);
      const page = new HistoryReader(historyDir).readPage({ event: 'onB' });
      expect(page.total).toBe(1);
      expect(page.entries).toHaveLength(1);
    });

    it('returns an empty page past the end without error', () => {
      writeMany(3);
      const page = new HistoryReader(historyDir).readPage({}, { offset: 100 });
      expect(page.entries).toEqual([]);
      expect(page.total).toBe(3);
    });
  });
});

describe('HistoryReader.countTriggers (activity counters, without parsing the payloads)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const WINDOWS = [5 * MINUTE, 60 * MINUTE, 24 * HOUR];
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-count-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  // The writer puts ts and type first: { ts, type, ...entry }
  const trigger = (atMs: number, eventId: string) => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId, event: 'onFoo', matchedCount: 0, totalCount: 0, payload: { big: 'x'.repeat(50) } });
  const NOW = Date.parse('2026-01-02T12:00:00.000Z');

  it('counts each trigger in every window that contains it', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - 1 * MINUTE, 'a'), trigger(NOW - 30 * MINUTE, 'b'), trigger(NOW - 5 * HOUR, 'c')]);
    writeDay(historyDir, '2026-01-01', [trigger(NOW - 20 * HOUR, 'd'), trigger(NOW - 25 * HOUR, 'e')]);
    expect(new HistoryReader(historyDir).countTriggers(NOW, WINDOWS)).toEqual([1, 2, 4]);
  });

  it('ignores outcome and filtered records: they are not events pushed', () => {
    writeDay(historyDir, '2026-01-02', [
      trigger(NOW - MINUTE, 'a'),
      { ts: new Date(NOW - MINUTE).toISOString(), type: 'outcome', eventId: 'a', event: 'onFoo', subscriberId: 's', status: 'success' },
      { ts: new Date(NOW - MINUTE).toISOString(), type: 'filtered', eventId: 'a', event: 'onFoo', subscriberId: 's', filter: 'x=1' },
    ]);
    expect(new HistoryReader(historyDir).countTriggers(NOW, WINDOWS)).toEqual([1, 1, 1]);
  });

  it('reads the previous day file when the window crosses midnight (UTC)', () => {
    const justAfterMidnight = Date.parse('2026-01-02T01:00:00.000Z');
    writeDay(historyDir, '2026-01-01', [trigger(Date.parse('2026-01-01T23:30:00.000Z'), 'late')]);
    writeDay(historyDir, '2026-01-02', [trigger(justAfterMidnight - 10 * MINUTE, 'recent')]);
    expect(new HistoryReader(historyDir).countTriggers(justAfterMidnight, WINDOWS)).toEqual([0, 1, 2]);
  });

  it('a trigger exactly at the edge of a window counts, one millisecond before does not', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - 5 * MINUTE, 'edge'), trigger(NOW - 5 * MINUTE - 1, 'just-out')]);
    expect(new HistoryReader(historyDir).countTriggers(NOW, [5 * MINUTE])).toEqual([1]);
  });

  it('is zero for a missing history directory and for no window at all', () => {
    expect(new HistoryReader(join(historyDir, 'missing')).countTriggers(NOW, WINDOWS)).toEqual([0, 0, 0]);
    expect(new HistoryReader(historyDir).countTriggers(NOW, [])).toEqual([]);
  });

  it('skips a line it cannot read instead of failing the whole count', () => {
    writeFileSync(join(historyDir, '2026-01-02.ndjson'), `not json at all\n${JSON.stringify(trigger(NOW - MINUTE, 'a'))}\n{"ts":"truncated`, 'utf-8');
    expect(new HistoryReader(historyDir).countTriggers(NOW, WINDOWS)).toEqual([1, 1, 1]);
  });

  it('does not depend on the order of the keys at the start of the line', () => {
    const swapped = JSON.stringify({ type: 'trigger', ts: new Date(NOW - MINUTE).toISOString(), eventId: 'swapped', event: 'onFoo' });
    writeFileSync(join(historyDir, '2026-01-02.ndjson'), swapped + '\n', 'utf-8');
    expect(new HistoryReader(historyDir).countTriggers(NOW, WINDOWS)).toEqual([1, 1, 1]);
  });

  it('does not count a record whose payload merely contains a trigger-looking text', () => {
    const outcome = JSON.stringify({ ts: new Date(NOW - MINUTE).toISOString(), type: 'outcome', eventId: 'o', event: 'onFoo', subscriberId: 's', status: 'success', target: 'echo {"type":"trigger"}' });
    writeFileSync(join(historyDir, '2026-01-02.ndjson'), outcome + '\n', 'utf-8');
    expect(new HistoryReader(historyDir).countTriggers(NOW, WINDOWS)).toEqual([0, 0, 0]);
  });

  it('understands what HistoryLog really writes (guards the line format the counter relies on)', () => {
    new HistoryLog(historyDir).logTrigger({ eventId: 'real', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 }, cwd: '/p' });
    expect(new HistoryReader(historyDir).countTriggers(Date.now(), WINDOWS)).toEqual([1, 1, 1]);
  });
});
