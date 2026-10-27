import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader } from './HistoryReader.js';
import { HistoryLog } from './HistoryLog.js';

// The tests that let HistoryLog stamp a record and then ask the reader about "now" pin the clock: a run across midnight or a slow
// machine cannot move the record out of its window.
const PINNED_NOW = new Date('2026-10-19T12:00:00.000Z');
function pinClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
}

afterEach(() => {
  vi.useRealTimers();
});

function writeDay(historyDir: string, date: string, records: object[]): void {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(historyDir, `${date}.ndjson`), content, 'utf-8');
}

describe('HistoryReader: the project of the outcomes (direction to-children)', () => {
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-reader-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  const records = [
    { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-a', event: 'onFoo', matchedCount: 2, totalCount: 2, projectId: 'aaaaaaaa' },
    { ts: '2026-01-01T10:00:01.000Z', type: 'outcome', eventId: 'ev-a', event: 'onFoo', subscriberId: 'aaaaaaaa/p', status: 'success', projectId: 'aaaaaaaa' },
    { ts: '2026-01-01T10:00:02.000Z', type: 'outcome', eventId: 'ev-a', event: 'onFoo', subscriberId: 'bbbbbbbb/c', status: 'failed', projectId: 'bbbbbbbb', emitterProjectId: 'aaaaaaaa' },
    { ts: '2026-01-01T10:00:02.500Z', type: 'filtered', eventId: 'ev-a', event: 'onFoo', subscriberId: 'cccccccc/g', filter: 'payload.x=1', projectId: 'cccccccc', emitterProjectId: 'aaaaaaaa' },
  ];

  it('keeps the project each subscriber was dispatched under, and the emitter for a descendant', () => {
    writeDay(historyDir, '2026-01-01', records);
    const [entry] = new HistoryReader(historyDir).read();
    const own = entry!.subscribers.find((sub) => sub.subscriberId === 'aaaaaaaa/p');
    const descendant = entry!.subscribers.find((sub) => sub.subscriberId === 'bbbbbbbb/c');
    expect(own).toMatchObject({ projectId: 'aaaaaaaa' });
    expect(own).not.toHaveProperty('emitterProjectId');
    expect(descendant).toMatchObject({ projectId: 'bbbbbbbb', emitterProjectId: 'aaaaaaaa' });
    expect(entry!.subscribers.find((sub) => sub.status === 'filtered')).toMatchObject({ projectId: 'cccccccc' });
  });

  it('the project filter finds an event under the project of the emitter AND under each descendant that ran or filtered a subscriber', () => {
    writeDay(historyDir, '2026-01-01', records);
    const reader = new HistoryReader(historyDir);
    expect(reader.read({ projectId: 'aaaaaaaa' }).map((entry) => entry.eventId)).toEqual(['ev-a']);
    expect(reader.read({ projectId: 'bbbbbbbb' }).map((entry) => entry.eventId)).toEqual(['ev-a']);
    expect(reader.read({ projectId: 'cccccccc' }).map((entry) => entry.eventId)).toEqual(['ev-a']);
    expect(reader.read({ projectId: 'dddddddd' })).toEqual([]);
  });

  it('a retry outcome (no trigger record) is found under the project it carries', () => {
    writeDay(historyDir, '2026-01-01', [{ ts: '2026-01-01T10:00:02.000Z', type: 'outcome', eventId: 'ev-r', event: 'onFoo', subscriberId: 'bbbbbbbb/c', status: 'success', projectId: 'bbbbbbbb' }]);
    expect(new HistoryReader(historyDir).read({ projectId: 'bbbbbbbb' }).map((entry) => entry.eventId)).toEqual(['ev-r']);
  });
});

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

  it('reads the project id recorded on the trigger, and filters on it: an entry of another project, or of none, is left out', () => {
    writeDay(historyDir, '2026-01-01', [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-a', event: 'onFoo', matchedCount: 0, totalCount: 0, projectId: '569c412d' },
      { ts: '2026-01-01T10:01:00.000Z', type: 'trigger', eventId: 'ev-b', event: 'onFoo', matchedCount: 0, totalCount: 0, projectId: 'deadbeef' },
      { ts: '2026-01-01T10:02:00.000Z', type: 'trigger', eventId: 'ev-c', event: 'onFoo', matchedCount: 0, totalCount: 0 },
    ]);
    const reader = new HistoryReader(historyDir);
    expect(reader.read().find((e) => e.eventId === 'ev-a')).toMatchObject({ projectId: '569c412d' });
    expect(reader.read({ projectId: '569c412d' }).map((e) => e.eventId)).toEqual(['ev-a']);
    expect(reader.read({ projectId: 'cafebabe' })).toEqual([]);
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
      // Any mtime different from the one cached by the first read: a fixed far-future date, no clock involved
      const future = new Date('2099-01-01T00:00:00.000Z');
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
    pinClock();
    new HistoryLog(historyDir).logTrigger({ eventId: 'real', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 }, cwd: '/p' });
    expect(new HistoryReader(historyDir).countTriggers(Date.now(), WINDOWS)).toEqual([1, 1, 1]);
  });
});

describe('HistoryReader.bucketTriggers (events per time slice, for the dashboard charts)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-buckets-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  const trigger = (atMs: number, eventId: string) => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId, event: 'onFoo', matchedCount: 0, totalCount: 0 });
  const NOW = Date.parse('2026-01-02T12:34:56.000Z');
  const localOffsetMs = (atMs: number) => -new Date(atMs).getTimezoneOffset() * MINUTE;

  it('aligns the buckets on the local clock: the first starts on a bucket boundary, the last holds now', () => {
    const { startMs, counts } = new HistoryReader(historyDir).bucketTriggers(NOW, HOUR, 24);
    expect(counts).toHaveLength(24);
    expect((startMs + localOffsetMs(NOW)) % HOUR).toBe(0);
    const lastStart = startMs + 23 * HOUR;
    expect(lastStart).toBeLessThanOrEqual(NOW);
    expect(NOW).toBeLessThan(lastStart + HOUR);
  });

  it('puts each trigger in its own bucket and ignores what is outside the range or after now', () => {
    const reader = new HistoryReader(historyDir);
    const { startMs } = reader.bucketTriggers(NOW, HOUR, 3);
    writeDay(historyDir, '2026-01-02', [
      trigger(startMs, 'first-bucket-start'),
      trigger(startMs + HOUR - 1, 'first-bucket-end'),
      trigger(startMs + HOUR, 'second-bucket'),
      trigger(NOW, 'now'),
      trigger(NOW + MINUTE, 'future'),
      trigger(startMs - 1, 'before-range'),
    ]);
    expect(reader.bucketTriggers(NOW, HOUR, 3).counts).toEqual([2, 1, 1]);
  });

  it('reads the previous day file when the range crosses midnight (UTC)', () => {
    const reader = new HistoryReader(historyDir);
    const { startMs } = reader.bucketTriggers(NOW, HOUR, 24);
    writeDay(historyDir, '2026-01-01', [trigger(startMs + MINUTE, 'yesterday')]);
    writeDay(historyDir, '2026-01-02', [trigger(NOW - MINUTE, 'today')]);
    const { counts } = reader.bucketTriggers(NOW, HOUR, 24);
    expect(counts[0]).toBe(1);
    expect(counts[23]).toBe(1);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(2);
  });

  it('counts only trigger records, and gives zeros for a missing history directory', () => {
    writeDay(historyDir, '2026-01-02', [{ ts: new Date(NOW - MINUTE).toISOString(), type: 'outcome', eventId: 'a', event: 'onFoo', subscriberId: 's', status: 'success' }]);
    expect(new HistoryReader(historyDir).bucketTriggers(NOW, HOUR, 4).counts).toEqual([0, 0, 0, 0]);
    expect(new HistoryReader(join(historyDir, 'missing')).bucketTriggers(NOW, HOUR, 4).counts).toEqual([0, 0, 0, 0]);
  });

  it('agrees with countTriggers on the total', () => {
    const reader = new HistoryReader(historyDir);
    const { startMs } = reader.bucketTriggers(NOW, 5 * MINUTE, 12);
    writeDay(historyDir, '2026-01-02', [trigger(NOW - MINUTE, 'a'), trigger(NOW - 20 * MINUTE, 'b'), trigger(NOW - 40 * MINUTE, 'c')]);
    const inRange = reader.bucketTriggers(NOW, 5 * MINUTE, 12).counts.reduce((sum, n) => sum + n, 0);
    expect(inRange).toBe(reader.countTriggers(NOW, [NOW - startMs])[0]);
  });
});

describe('HistoryReader.bucketOutcomes (how dispatches ended, per time slice)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const NOW = Date.parse('2026-01-02T12:34:56.000Z');
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-outcomes-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  const outcome = (atMs: number, status: string, extra: object = {}) => ({ ts: new Date(atMs).toISOString(), type: 'outcome', eventId: 'e', event: 'onFoo', subscriberId: 'onFoo[0]', status, ...extra });
  const sum = (counts: number[]) => counts.reduce((total, n) => total + n, 0);

  it('counts success, failed and dlq outcomes in the slice of their time', () => {
    const reader = new HistoryReader(historyDir);
    const { startMs } = reader.bucketOutcomes(NOW, HOUR, 3);
    writeDay(historyDir, '2026-01-02', [
      outcome(startMs + MINUTE, 'success'),
      outcome(startMs + 2 * MINUTE, 'success'),
      outcome(startMs + HOUR + MINUTE, 'failed'),
      outcome(NOW - MINUTE, 'dlq'),
      outcome(NOW - MINUTE, 'failed'),
    ]);
    const result = reader.bucketOutcomes(NOW, HOUR, 3);
    expect(result.success).toEqual([2, 0, 0]);
    expect(result.failed).toEqual([0, 1, 1]);
    expect(result.dlq).toEqual([0, 0, 1]);
  });

  it('ignores trigger and filtered records, and what is outside the range or after now', () => {
    const reader = new HistoryReader(historyDir);
    const { startMs } = reader.bucketOutcomes(NOW, HOUR, 2);
    writeDay(historyDir, '2026-01-02', [
      { ts: new Date(NOW - MINUTE).toISOString(), type: 'trigger', eventId: 'e', event: 'onFoo', matchedCount: 1, totalCount: 1 },
      { ts: new Date(NOW - MINUTE).toISOString(), type: 'filtered', eventId: 'e', event: 'onFoo', subscriberId: 's', filter: 'status=success' },
      outcome(startMs - 1, 'success'),
      outcome(NOW + MINUTE, 'success'),
    ]);
    const result = reader.bucketOutcomes(NOW, HOUR, 2);
    expect(sum(result.success) + sum(result.failed) + sum(result.dlq)).toBe(0);
  });

  it('takes the status of the record, not words in the free text after it (a target that mentions "status":"dlq")', () => {
    writeDay(historyDir, '2026-01-02', [outcome(NOW - MINUTE, 'success', { target: 'echo {"status":"dlq"}' })]);
    const result = new HistoryReader(historyDir).bucketOutcomes(NOW, HOUR, 2);
    expect(sum(result.success)).toBe(1);
    expect(sum(result.dlq)).toBe(0);
  });

  it('reads what HistoryLog writes, and is zeros for a missing history directory', () => {
    pinClock();
    const log = new HistoryLog(historyDir);
    log.logOutcome({ eventId: 'e1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'failed', target: 'echo x' });
    const result = new HistoryReader(historyDir).bucketOutcomes(Date.now(), HOUR, 24);
    expect(sum(result.failed)).toBe(1);
    expect(sum(new HistoryReader(join(historyDir, 'missing')).bucketOutcomes(NOW, HOUR, 4).success)).toBe(0);
  });
});

describe('HistoryReader breakdowns (events and subscribers over a window)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const NOW = Date.parse('2026-01-02T12:00:00.000Z');
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-breakdown-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  const trigger = (atMs: number, event: string) => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: crypto.randomUUID(), event, matchedCount: 0, totalCount: 0, payload: { big: 'x'.repeat(2000) } });
  const outcome = (atMs: number, subscriberId: string, status: string) => ({ ts: new Date(atMs).toISOString(), type: 'outcome', eventId: crypto.randomUUID(), event: 'onFoo', subscriberId, status, target: 'echo' });

  it('countTriggersByEvent counts per event name inside the window only', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - MINUTE, 'onA'), trigger(NOW - 2 * MINUTE, 'onA'), trigger(NOW - HOUR, 'onB')]);
    writeDay(historyDir, '2026-01-01', [trigger(NOW - 23 * HOUR, 'onA'), trigger(NOW - 30 * HOUR, 'onA')]);
    const counts = new HistoryReader(historyDir).countTriggersByEvent(NOW, 24 * HOUR);
    expect(Object.fromEntries(counts)).toEqual({ onA: 3, onB: 1 });
  });

  it('countTriggersByEvent reads names with dots, quotes and a backslash as they were pushed', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - MINUTE, 'on.github.workflow_run'), trigger(NOW - MINUTE, 'say "hi" \\ there')]);
    const counts = new HistoryReader(historyDir).countTriggersByEvent(NOW, HOUR);
    expect([...counts.keys()].sort()).toEqual(['on.github.workflow_run', 'say "hi" \\ there']);
  });

  it('countTriggersByEvent ignores outcome records and is empty for a missing directory', () => {
    writeDay(historyDir, '2026-01-02', [outcome(NOW - MINUTE, 'onFoo[0]', 'success')]);
    expect(new HistoryReader(historyDir).countTriggersByEvent(NOW, HOUR).size).toBe(0);
    expect(new HistoryReader(join(historyDir, 'missing')).countTriggersByEvent(NOW, HOUR).size).toBe(0);
  });

  it('eventActivity gives, per event name, the pushes of the window, the pushes of its recent part and when it was last pushed', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - MINUTE, 'onA'), trigger(NOW - 2 * HOUR, 'onA'), trigger(NOW - 3 * HOUR, 'onB')]);
    writeDay(historyDir, '2026-01-01', [trigger(NOW - 30 * HOUR, 'onB'), trigger(NOW - 40 * HOUR, 'onC')]);
    const activity = new HistoryReader(historyDir).eventActivity(NOW, 3 * 24 * HOUR, 24 * HOUR);
    expect(Object.fromEntries(activity)).toEqual({
      onA: { count: 2, recentCount: 2, lastSeenMs: NOW - MINUTE },
      onB: { count: 2, recentCount: 1, lastSeenMs: NOW - 3 * HOUR },
      onC: { count: 1, recentCount: 0, lastSeenMs: NOW - 40 * HOUR },
    });
  });

  it('eventActivity leaves out what is older than the window, ignores outcome records, and is empty for a missing directory', () => {
    writeDay(historyDir, '2026-01-02', [trigger(NOW - 2 * HOUR, 'onA'), outcome(NOW - MINUTE, 'onFoo[0]', 'success')]);
    writeDay(historyDir, '2026-01-01', [trigger(NOW - 30 * HOUR, 'onOld')]);
    expect([...new HistoryReader(historyDir).eventActivity(NOW, 24 * HOUR, HOUR).keys()]).toEqual(['onA']);
    expect(new HistoryReader(join(historyDir, 'missing')).eventActivity(NOW, HOUR, HOUR).size).toBe(0);
  });

  it('countOutcomesBySubscriber counts each status per subscriber inside the window', () => {
    writeDay(historyDir, '2026-01-02', [
      outcome(NOW - MINUTE, 'onA[0]', 'success'),
      outcome(NOW - MINUTE, 'onA[0]', 'success'),
      outcome(NOW - MINUTE, 'onA[0]', 'failed'),
      outcome(NOW - MINUTE, 'onB[0]', 'dlq'),
      outcome(NOW + MINUTE, 'onB[0]', 'success'),
    ]);
    writeDay(historyDir, '2026-01-01', [outcome(NOW - 30 * HOUR, 'onA[0]', 'success')]);
    const counts = new HistoryReader(historyDir).countOutcomesBySubscriber(NOW, 24 * HOUR);
    expect(Object.fromEntries(counts)).toEqual({
      'onA[0]': { success: 2, failed: 1, dlq: 0 },
      'onB[0]': { success: 0, failed: 0, dlq: 1 },
    });
  });

  it('reads what HistoryLog writes', () => {
    pinClock();
    const log = new HistoryLog(historyDir);
    log.logTrigger({ eventId: 'e1', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 } });
    log.logOutcome({ eventId: 'e1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'success', target: 'echo' });
    const reader = new HistoryReader(historyDir);
    expect(Object.fromEntries(reader.countTriggersByEvent(Date.now(), HOUR))).toEqual({ onFoo: 1 });
    expect(Object.fromEntries(reader.countOutcomesBySubscriber(Date.now(), HOUR))).toEqual({ 'onFoo[0]': { success: 1, failed: 0, dlq: 0 } });
  });
});
