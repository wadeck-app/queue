import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader } from './HistoryReader.js';
import { HistoryLog } from './HistoryLog.js';

let historyDir: string;

beforeEach(() => {
  historyDir = join(tmpdir(), `queue-history-find-trigger-${crypto.randomUUID()}`);
  mkdirSync(historyDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(historyDir, { recursive: true, force: true });
});

function writeDay(date: string, records: object[]): void {
  writeFileSync(join(historyDir, `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

const trigger = (day: string, eventId: string, extra: object = {}): object => ({ ts: `${day}T10:00:00.000Z`, type: 'trigger', eventId, event: 'onA', matchedCount: 0, totalCount: 0, ...extra });

describe('HistoryReader.findTrigger', () => {
  it('returns the push: name, payload, time and project', () => {
    writeDay('2026-01-01', [trigger('2026-01-01', 'ev-1', { payload: { a: 1 }, project: 'app', projectId: 'p1', cwd: '/p', replayOf: 'ev-0', direction: ['to-children'], causedBy: { eventId: 'ev-0', subscriberId: 's' } })]);

    expect(new HistoryReader(historyDir).findTrigger('ev-1')).toEqual({
      ts: '2026-01-01T10:00:00.000Z', eventId: 'ev-1', event: 'onA', payload: { a: 1 }, project: 'app', projectId: 'p1', cwd: '/p', replayOf: 'ev-0', direction: ['to-children'], causedBy: { eventId: 'ev-0', subscriberId: 's' },
    });
  });

  it('is undefined for an unknown id, an id with only outcomes (a retry), a missing directory and an id that is a prefix of another', () => {
    writeDay('2026-01-01', [
      trigger('2026-01-01', 'ev-10'),
      { ts: '2026-01-01T10:00:01.000Z', type: 'outcome', eventId: 'wal-1', event: 'onA', subscriberId: 's', status: 'success' },
    ]);
    const reader = new HistoryReader(historyDir);

    expect(reader.findTrigger('nope')).toBeUndefined();
    expect(reader.findTrigger('wal-1')).toBeUndefined();
    expect(reader.findTrigger('ev-1')).toBeUndefined();
    expect(new HistoryReader(join(historyDir, 'missing')).findTrigger('ev-1')).toBeUndefined();
  });

  it('finds the trigger in an old day file, and the newest one when an id was written twice', () => {
    writeDay('2026-01-01', [trigger('2026-01-01', 'ev-1', { payload: 'old' }), trigger('2026-01-01', 'ev-2')]);
    writeDay('2026-01-02', [trigger('2026-01-02', 'ev-3')]);
    writeDay('2026-01-03', [trigger('2026-01-03', 'ev-1', { payload: 'new' })]);
    const reader = new HistoryReader(historyDir);

    expect(reader.findTrigger('ev-2')?.eventId).toBe('ev-2');
    expect(reader.findTrigger('ev-1')?.payload).toBe('new');
  });

  it('matches the key order HistoryLog really writes (guards the byte needle against a change of the writer)', () => {
    new HistoryLog(historyDir).logTrigger({ eventId: 'real', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 }, cwd: '/p', project: 'app', projectId: 'p1' });

    expect(new HistoryReader(historyDir).findTrigger('real')).toMatchObject({ eventId: 'real', event: 'onFoo', payload: { a: 1 }, cwd: '/p', project: 'app', projectId: 'p1' });
  });

  it('handles an id that needs JSON escaping', () => {
    const id = 'we"ird\\id\n';
    writeDay('2026-01-01', [trigger('2026-01-01', id, { payload: 7 })]);

    expect(new HistoryReader(historyDir).findTrigger(id)?.payload).toBe(7);
  });

  describe('a hostile payload cannot answer for another event', () => {
    it('a payload STRING containing the needle text is escaped in the file and never matches', () => {
      writeDay('2026-01-01', [trigger('2026-01-01', 'real', { payload: { note: '"type":"trigger","eventId":"victim"' } })]);

      expect(new HistoryReader(historyDir).findTrigger('victim')).toBeUndefined();
    });

    it('a payload OBJECT whose keys spell the needle (raw bytes in the file) is rejected because it is not at the head of its line', () => {
      writeDay('2026-01-01', [
        trigger('2026-01-01', 'victim', { payload: { genuine: true } }),
        trigger('2026-01-01', 'attacker', { payload: { nested: { type: 'trigger', eventId: 'victim', event: 'forged', payload: { forged: true } } } }),
      ]);
      // The raw needle really is in the attacker's line
      const raw = JSON.stringify(trigger('2026-01-01', 'attacker', { payload: { nested: { type: 'trigger', eventId: 'victim' } } }));
      expect(raw).toContain('"type":"trigger","eventId":"victim"');

      const found = new HistoryReader(historyDir).findTrigger('victim');

      expect(found).toMatchObject({ eventId: 'victim', event: 'onA', payload: { genuine: true } });
    });

    it('a payload object spelling the needle is not a hit when the real trigger is gone', () => {
      writeDay('2026-01-01', [trigger('2026-01-01', 'attacker', { payload: { type: 'trigger', eventId: 'victim' } })]);

      expect(new HistoryReader(historyDir).findTrigger('victim')).toBeUndefined();
    });

    it('a payload object spelling the head of a line too (a forged "ts" prefix inside a string) is still rejected', () => {
      writeDay('2026-01-01', [trigger('2026-01-01', 'attacker', { payload: 'x\n{"ts":"2026-01-01T00:00:00.000Z","type":"trigger","eventId":"victim"' })]);

      expect(new HistoryReader(historyDir).findTrigger('victim')).toBeUndefined();
    });
  });

  describe('cost', () => {
    function bigHistory(): void {
      for (let day = 1; day <= 5; day++) {
        const date = `2026-01-0${day}`;
        writeDay(date, Array.from({ length: 300 }, (_, i) => trigger(date, `ev-${day}-${i}`, { payload: { n: i } })));
      }
    }

    it('parses only the line of the hit, while read() parses every line', () => {
      bigHistory();
      const parse = vi.spyOn(JSON, 'parse');

      new HistoryReader(historyDir).read();
      const readCalls = parse.mock.calls.length;
      parse.mockClear();
      const found = new HistoryReader(historyDir).findTrigger('ev-5-150');

      expect(readCalls).toBeGreaterThanOrEqual(1500);
      expect(found?.eventId).toBe('ev-5-150');
      expect(parse.mock.calls.length).toBe(1);
    });

    it('an id absent from the history parses nothing at all', () => {
      bigHistory();
      const parse = vi.spyOn(JSON, 'parse');

      expect(new HistoryReader(historyDir).findTrigger('absent')).toBeUndefined();
      expect(parse.mock.calls.length).toBe(0);
    });
  });
});

describe('HistoryReader.findByEventId (same answers as read().find, without parsing the whole history)', () => {
  it('returns the same entry as read(), outcomes and filtered records of later days included', () => {
    writeDay('2026-01-01', [
      trigger('2026-01-01', 'ev-1', { payload: { a: 1 }, matchedCount: 2, totalCount: 3 }),
      { ts: '2026-01-01T10:00:01.000Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 's1', status: 'failed', target: 'x' },
      { ts: '2026-01-01T10:00:01.500Z', type: 'filtered', eventId: 'ev-1', event: 'onA', subscriberId: 's3', filter: 'payload.a=2', actual: '1' },
      trigger('2026-01-01', 'ev-2', { payload: { forged: { eventId: 'ev-1' } } }),
    ]);
    writeDay('2026-01-02', [
      { ts: '2026-01-02T00:00:01.000Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 's2', status: 'success' },
    ]);
    const reader = new HistoryReader(historyDir);

    const expected = reader.read().find((e) => e.eventId === 'ev-1');
    const found = new HistoryReader(historyDir).findByEventId('ev-1');

    expect(found).toEqual(expected);
    expect(found!.subscribers.map((s) => s.subscriberId)).toEqual(['s1', 's3', 's2']);
    expect(new HistoryReader(historyDir).findByEventId('ev-2')).toEqual(reader.read().find((e) => e.eventId === 'ev-2'));
  });

  it('an id with no trigger gives the orphan entry, as read() does', () => {
    writeDay('2026-01-01', [
      trigger('2026-01-01', 'ev-1'),
      { ts: '2026-01-01T10:00:00.000Z', type: 'outcome', eventId: 'wal-1', event: 'onA', subscriberId: 's', status: 'success' },
    ]);

    const found = new HistoryReader(historyDir).findByEventId('wal-1');

    expect(found).toMatchObject({ eventId: 'wal-1', orphan: true });
    expect(found).toEqual(new HistoryReader(historyDir).read().find((e) => e.eventId === 'wal-1'));
  });

  it('parses only the lines that carry the id', () => {
    for (let day = 1; day <= 3; day++) {
      const date = `2026-01-0${day}`;
      writeDay(date, Array.from({ length: 200 }, (_, i) => trigger(date, `ev-${day}-${i}`)));
    }
    const parse = vi.spyOn(JSON, 'parse');

    const found = new HistoryReader(historyDir).findByEventId('ev-3-10');

    expect(found?.eventId).toBe('ev-3-10');
    // The hit line twice at most (locate, then collect); nowhere near the 600 lines
    expect(parse.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
