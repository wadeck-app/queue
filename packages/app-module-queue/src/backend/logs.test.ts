import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogs, DEFAULT_LOG_LINES, MAX_LOG_LINES } from './logs.js';
import { InvalidQueryError } from './errors.js';

let configDir: string;

function writeRecords(date: string, records: object[]): void {
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  writeFileSync(join(configDir, 'logs', `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const diagnostics = (date: string, count: number): object[] =>
  Array.from({ length: count }, (_, i) => ({ ts: `${date}T10:00:${String(i % 60).padStart(2, '0')}.000Z`, type: 'diagnostic', source: 'test', message: `m${i}` }));

const dispatch = (date: string, second: number, subscriberId: string, status = 'success'): object => ({
  ts: `${date}T10:00:${String(second).padStart(2, '0')}.000Z`,
  type: 'dispatch',
  subscriberId,
  status,
  target: 'echo hi',
  durationMs: 12,
});

const miss = (date: string, second: number, subscriberId: string): object => ({
  ts: `${date}T10:00:${String(second).padStart(2, '0')}.000Z`,
  type: 'filter-miss',
  subscriberId,
  filter: 'payload.action=completed',
  reason: 'value differs',
});

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-logs-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('getLogs', () => {
  it('returns one short row per record, newest first: the time, ok/miss/fail/dlq/info and the event', () => {
    writeRecords('2026-10-18', [dispatch('2026-10-18', 1, 'on.github.push[0]'), miss('2026-10-18', 2, 'on.github.workflow_job[0]')]);
    const response = getLogs(configDir, { date: '2026-10-18' });
    expect(response).toMatchObject({ date: '2026-10-18', present: true, omitted: 0 });
    expect(response.records.map((row) => [row.time, row.outcome, row.event])).toEqual([
      ['10:00:02', 'miss', 'on.github.workflow_job'],
      ['10:00:01', 'ok', 'on.github.push'],
    ]);
  });

  it('keeps the detail for the expanded row: the whole record as pretty JSON, and the subscriber', () => {
    writeRecords('2026-10-18', [dispatch('2026-10-18', 1, 'on.github.push[2]', 'failed')]);
    const [row] = getLogs(configDir, { date: '2026-10-18' }).records;
    expect(row?.subscriberId).toBe('on.github.push[2]');
    expect(JSON.parse(row!.detailsText)).toMatchObject({ type: 'dispatch', status: 'failed', target: 'echo hi', durationMs: 12 });
    expect(row?.detailsText).toContain('\n');
  });

  it('returns only what the table shows and the detail: no other field', () => {
    writeRecords('2026-10-18', [dispatch('2026-10-18', 1, 'a[0]')]);
    expect(Object.keys(getLogs(configDir, { date: '2026-10-18' }).records[0]!).sort()).toEqual(['detailsText', 'event', 'outcome', 'subscriberId', 'time']);
  });

  it('filters by outcome before the limit', () => {
    writeRecords('2026-10-18', [miss('2026-10-18', 0, 'a[0]'), ...Array.from({ length: 5 }, (_, i) => dispatch('2026-10-18', i + 1, `b${i}[0]`))]);
    const response = getLogs(configDir, { date: '2026-10-18', limit: '2', outcome: 'miss' });
    expect(response.records.map((row) => row.outcome)).toEqual(['miss']);
    expect(response.omitted).toBe(0);
  });

  it('filters by event name, a case-insensitive substring', () => {
    writeRecords('2026-10-18', [dispatch('2026-10-18', 1, 'on.github.push[0]'), dispatch('2026-10-18', 2, 'job.started[0]')]);
    expect(getLogs(configDir, { date: '2026-10-18', event: 'GitHub' }).records.map((row) => row.event)).toEqual(['on.github.push']);
  });

  it('says how many matching records the limit left out', () => {
    writeRecords('2026-10-18', diagnostics('2026-10-18', 3));
    expect(getLogs(configDir, { date: '2026-10-18', limit: '2' })).toMatchObject({ omitted: 1 });
  });

  it(`shows at most ${DEFAULT_LOG_LINES} records when no limit is given`, () => {
    writeRecords('2026-10-18', diagnostics('2026-10-18', DEFAULT_LOG_LINES + 5));
    const response = getLogs(configDir, { date: '2026-10-18' });
    expect(response.records).toHaveLength(DEFAULT_LOG_LINES);
    expect(response.omitted).toBe(5);
  });

  it('a day without a log file answers present: false, not an error', () => {
    expect(getLogs(configDir, { date: '2026-01-01' })).toMatchObject({ date: '2026-01-01', present: false, records: [], omitted: 0 });
  });

  it('defaults to today (UTC) when no date is given', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(getLogs(configDir, {}).date).toBe(today);
  });

  it.each([
    [{ date: '../wal' }, /date must be a day as YYYY-MM-DD/],
    [{ date: '2026-1-1' }, /date must be a day as YYYY-MM-DD/],
    [{ date: ['2026-10-18', '2026-10-19'] }, /date must be given once/],
    [{ limit: '0' }, /limit must be an integer between 1 and/],
    [{ limit: String(MAX_LOG_LINES + 1) }, /limit must be an integer between 1 and/],
    [{ limit: 'abc' }, /limit must be an integer between 1 and/],
    [{ outcome: 'nope' }, /outcome must be one of ok, miss, fail, dlq, info, got: "nope"/],
    [{ event: ['a', 'b'] }, /event must be given once/],
  ])('rejects %j with an actionable InvalidQueryError', (query, message) => {
    expect(() => getLogs(configDir, query)).toThrowError(InvalidQueryError);
    expect(() => getLogs(configDir, query)).toThrowError(message);
  });
});
