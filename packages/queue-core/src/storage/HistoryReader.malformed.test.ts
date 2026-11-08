import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader } from './HistoryReader.js';

// A malformed line (a write interrupted by a crash, a glued record, hand editing) must not hide the lines around it for the 90 days the file lives
const GOOD_A = { ts: '2026-10-19T10:00:00.000Z', type: 'trigger', eventId: 'ev-a', event: 'onA', matchedCount: 1, totalCount: 1, payload: { n: 1 } };
const OUTCOME_A = { ts: '2026-10-19T10:00:01.000Z', type: 'outcome', eventId: 'ev-a', event: 'onA', subscriberId: 's1', status: 'success' };
const GOOD_B = { ts: '2026-10-19T11:00:00.000Z', type: 'trigger', eventId: 'ev-b', event: 'onB', matchedCount: 0, totalCount: 0 };
const TORN = '{"ts":"2026-10-19T10:30:00.000Z","type":"trigger","eventId":"ev-torn","event":"onTorn","matchedCount":1,"tot';
const NOW_MS = Date.parse('2026-10-19T12:00:00.000Z');

describe('HistoryReader with a malformed line in a day file', () => {
  let historyDir: string;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-malformed-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // GOOD_A, OUTCOME_A, a torn line, GOOD_B: the torn line sits in the middle
  const writeWithTornMiddle = (day = '2026-10-19'): void => {
    writeFileSync(join(historyDir, `${day}.ndjson`), [JSON.stringify(GOOD_A), JSON.stringify(OUTCOME_A), TORN, JSON.stringify(GOOD_B)].join('\n') + '\n', 'utf-8');
  };

  it('read() skips the malformed line, keeps every line around it and reports it (file, count, first sample)', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);

    const entries = reader.read();

    expect(entries.map(e => e.eventId).sort()).toEqual(['ev-a', 'ev-b']);
    expect(entries.find(e => e.eventId === 'ev-a')!.subscribers).toHaveLength(1);
    expect(reader.malformedLines()).toEqual([{ file: '2026-10-19.ndjson', count: 1, sample: TORN }]);
  });

  it('reports a long malformed line truncated, and counts every malformed line of a file', () => {
    const long = '{"broken":"' + 'x'.repeat(500);
    writeFileSync(join(historyDir, '2026-10-19.ndjson'), [long, JSON.stringify(GOOD_A), 'not json', ''].join('\n'), 'utf-8');
    const reader = new HistoryReader(historyDir);
    reader.read();
    const [report] = reader.malformedLines();
    expect(report!.count).toBe(2);
    expect(report!.sample.length).toBeLessThanOrEqual(120);
    expect(report!.sample.startsWith('{"broken":"xxx')).toBe(true);
  });

  it('readPage() carries the warning texts, naming the file path and what to do; a clean history has none', () => {
    writeWithTornMiddle();
    const page = new HistoryReader(historyDir).readPage();
    expect(page.total).toBe(2);
    expect(page.warnings).toHaveLength(1);
    expect(page.warnings![0]).toContain(join(historyDir, '2026-10-19.ndjson'));
    expect(page.warnings![0]).toContain('1 malformed line');
    expect(page.warnings![0]).toContain(TORN.slice(0, 40));
    expect(page.warnings![0]).toMatch(/interrupted|crash/);
    expect(page.warnings![0]).toMatch(/repair|delete/);

    writeFileSync(join(historyDir, '2026-10-19.ndjson'), JSON.stringify(GOOD_A) + '\n', 'utf-8');
    const clean = new HistoryReader(historyDir).readPage();
    expect(clean).not.toHaveProperty('warnings');
  });

  it('a long-lived reader (--follow) keeps reporting a cached file, and stops once the file is repaired', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);
    reader.read();
    // Same mtime: served from the cache, the report must survive it
    reader.read();
    expect(reader.malformedLines()).toHaveLength(1);

    writeFileSync(join(historyDir, '2026-10-19.ndjson'), JSON.stringify(GOOD_A) + '\n', 'utf-8');
    // The cache keys on mtime: make sure the rewritten file is seen as changed
    const later = new Date(Date.now() + 5000);
    utimesSync(join(historyDir, '2026-10-19.ndjson'), later, later);
    reader.read();
    expect(reader.malformedLines()).toEqual([]);
  });

  it('findTrigger() finds an event pushed after the malformed line, and one before it', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);
    expect(reader.findTrigger('ev-b')).toMatchObject({ eventId: 'ev-b', event: 'onB' });
    expect(reader.findTrigger('ev-a')).toMatchObject({ eventId: 'ev-a', payload: { n: 1 } });
  });

  it('findTrigger() does not throw on the torn trigger itself and does not answer with it', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);
    expect(reader.findTrigger('ev-torn')).toBeUndefined();
    expect(reader.malformedLines().map(m => m.file)).toEqual(['2026-10-19.ndjson']);
  });

  it('findByEventId() and readProject() skip the malformed line that carries the id instead of throwing', () => {
    writeFileSync(
      join(historyDir, '2026-10-19.ndjson'),
      [JSON.stringify({ ...GOOD_B, projectId: 'aaaaaaaa' }), 'aaaaaaaa ev-b {broken', JSON.stringify({ ...OUTCOME_A, eventId: 'ev-b', projectId: 'aaaaaaaa' })].join('\n') + '\n',
      'utf-8',
    );
    const reader = new HistoryReader(historyDir);
    expect(reader.findByEventId('ev-b')).toMatchObject({ eventId: 'ev-b', subscribers: [{ subscriberId: 's1' }] });
    expect(reader.readProject('aaaaaaaa').map(e => e.eventId)).toEqual(['ev-b']);
    expect(reader.malformedLines()).toEqual([{ file: '2026-10-19.ndjson', count: 1, sample: 'aaaaaaaa ev-b {broken' }]);
  });

  it('countTriggers() and read() agree: a torn trigger line is counted by neither, a valid trigger after it by both', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);
    const triggersByRead = reader.read().filter(e => !e.orphan).length;
    const [count] = reader.countTriggers(NOW_MS, [24 * 3600_000]);
    expect(triggersByRead).toBe(2);
    expect(count).toBe(triggersByRead);
  });

  it('countTriggers() does not count a record glued behind a torn tail (the line is not valid JSON, like for read())', () => {
    // The old writer appended the next record right after a torn tail without a newline
    writeFileSync(join(historyDir, '2026-10-19.ndjson'), JSON.stringify(GOOD_A) + '\n' + TORN + JSON.stringify(GOOD_B) + '\n', 'utf-8');
    const reader = new HistoryReader(historyDir);
    expect(reader.read().map(e => e.eventId)).toEqual(['ev-a']);
    expect(reader.countTriggers(NOW_MS, [24 * 3600_000])).toEqual([1]);
    expect(reader.malformedLines()).toHaveLength(1);
  });

  it('every aggregate (by event, activity, buckets, outcomes) skips the torn line without throwing and reports it', () => {
    writeWithTornMiddle();
    const reader = new HistoryReader(historyDir);
    expect([...reader.countTriggersByEvent(NOW_MS, 24 * 3600_000).entries()].sort()).toEqual([['onA', 1], ['onB', 1]]);
    expect(reader.eventActivity(NOW_MS, 24 * 3600_000, 3600_000).has('onTorn')).toBe(false);
    expect(reader.bucketTriggers(NOW_MS, 3600_000, 24).counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(reader.bucketOutcomes(NOW_MS, 3600_000, 24).success.reduce((a, b) => a + b, 0)).toBe(1);
    expect(reader.malformedLines()).toHaveLength(1);
  });

  it('malformed lines of several files are reported per file, oldest first', () => {
    writeWithTornMiddle('2026-10-18');
    writeWithTornMiddle('2026-10-19');
    const reader = new HistoryReader(historyDir);
    reader.read();
    expect(reader.malformedLines().map(m => m.file)).toEqual(['2026-10-18.ndjson', '2026-10-19.ndjson']);
  });
});

