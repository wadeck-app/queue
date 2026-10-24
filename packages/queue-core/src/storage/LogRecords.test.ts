import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eventOfSubscriber, parseLogRecord, readLogRecords } from './LogRecords.js';

const dispatch = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: '2026-01-02T10:11:12.000Z', type: 'dispatch', subscriberId: 'onFoo[0]', status: 'success', durationMs: 12, target: 'echo hi', ...overrides });
const miss = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: '2026-01-02T10:11:13.000Z', type: 'filter-miss', subscriberId: 'on.github.workflow_job[0]', filter: 'payload.action=completed', reason: 'value differs', path: 'payload.action', expected: 'completed', actual: 'in_progress', ...overrides });

describe('eventOfSubscriber', () => {
  it('drops the index of the subscriber id: the rest is the event', () => {
    expect(eventOfSubscriber('on.github.workflow_job[0]')).toBe('on.github.workflow_job');
    expect(eventOfSubscriber('onFoo[12]')).toBe('onFoo');
  });

  it('keeps an id that has no index as it is', () => {
    expect(eventOfSubscriber('custom-id')).toBe('custom-id');
  });
});

describe('parseLogRecord', () => {
  it('reads a successful dispatch as ok, with its event and the whole record as details', () => {
    expect(parseLogRecord(dispatch())).toMatchObject({
      ts: '2026-01-02T10:11:12.000Z',
      time: '10:11:12',
      outcome: 'ok',
      event: 'onFoo',
      subscriberId: 'onFoo[0]',
      entry: { type: 'dispatch', status: 'success', durationMs: 12 },
    });
  });

  it.each([
    ['failed', 'fail'],
    ['dlq', 'dlq'],
  ])('reads a dispatch whose status is %s as %s', (status, outcome) => {
    expect(parseLogRecord(dispatch({ status }))?.outcome).toBe(outcome);
  });

  it('reads a filter miss as miss: the subscriber was not run because the filter did not match', () => {
    expect(parseLogRecord(miss())).toMatchObject({ outcome: 'miss', event: 'on.github.workflow_job', subscriberId: 'on.github.workflow_job[0]' });
  });

  it('reads a diagnostic as info, named by its source', () => {
    const record = parseLogRecord(JSON.stringify({ ts: '2026-01-02T10:00:00.000Z', type: 'diagnostic', source: 'QueueDaemon.push', message: 'config error' }));
    expect(record).toMatchObject({ outcome: 'info', event: 'QueueDaemon.push' });
  });

  it('reads a CLI invocation as info from the cli', () => {
    const record = parseLogRecord(JSON.stringify({ ts: '2026-01-02T10:00:00.000Z', level: 'info', msg: 'cmd: queue status' }));
    expect(record).toMatchObject({ outcome: 'info', event: 'cli' });
  });

  it('returns undefined for a blank line', () => {
    expect(parseLogRecord('')).toBeUndefined();
    expect(parseLogRecord('   ')).toBeUndefined();
  });

  it('keeps a line that is not JSON visible instead of dropping it', () => {
    expect(parseLogRecord('not json at all')).toMatchObject({ outcome: 'info', event: '(unreadable line)', entry: { raw: 'not json at all' } });
  });

  it('keeps a record of an unknown type visible', () => {
    expect(parseLogRecord(JSON.stringify({ ts: '2026-01-02T10:00:00.000Z', type: 'something-new' }))).toMatchObject({ outcome: 'info', event: 'something-new' });
  });
});

describe('readLogRecords', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-log-records-'));
    mkdirSync(join(configDir, 'logs'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeDay(date: string, lines: string[]): void {
    writeFileSync(join(configDir, 'logs', `${date}.ndjson`), lines.join('\n') + '\n');
  }

  it('returns the records of a day, newest first', () => {
    writeDay('2026-01-02', [dispatch({ subscriberId: 'a[0]' }), miss(), dispatch({ subscriberId: 'c[0]', ts: '2026-01-02T10:11:14.000Z' })]);
    const result = readLogRecords(configDir, { date: '2026-01-02', limit: 10 });
    expect(result.present).toBe(true);
    expect(result.records.map((record) => record.event)).toEqual(['c', 'on.github.workflow_job', 'a']);
    expect(result.omitted).toBe(0);
  });

  it('keeps the newest records when the day has more than the limit, and says how many were left out', () => {
    writeDay('2026-01-02', ['a', 'b', 'c', 'd'].map((id) => dispatch({ subscriberId: `${id}[0]` })));
    const result = readLogRecords(configDir, { date: '2026-01-02', limit: 2 });
    expect(result.records.map((record) => record.event)).toEqual(['d', 'c']);
    expect(result.omitted).toBe(2);
  });

  it('filters by outcome before applying the limit, so a rare outcome is found among many ok ones', () => {
    writeDay('2026-01-02', [miss(), ...Array.from({ length: 5 }, (_, i) => dispatch({ subscriberId: `ok${i}[0]` }))]);
    const result = readLogRecords(configDir, { date: '2026-01-02', limit: 2, outcome: 'miss' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.outcome).toBe('miss');
  });

  it('filters by event name, a case-insensitive substring', () => {
    writeDay('2026-01-02', [dispatch({ subscriberId: 'on.github.push[0]' }), dispatch({ subscriberId: 'job.started[0]' })]);
    const result = readLogRecords(configDir, { date: '2026-01-02', limit: 10, event: 'GITHUB' });
    expect(result.records.map((record) => record.event)).toEqual(['on.github.push']);
  });

  it('combines the filters', () => {
    writeDay('2026-01-02', [miss(), dispatch({ subscriberId: 'on.github.workflow_job[1]' }), dispatch({ subscriberId: 'other[0]' })]);
    const result = readLogRecords(configDir, { date: '2026-01-02', limit: 10, outcome: 'ok', event: 'github' });
    expect(result.records.map((record) => record.subscriberId)).toEqual(['on.github.workflow_job[1]']);
  });

  it('says nothing was logged that day when there is no file', () => {
    expect(readLogRecords(configDir, { date: '2026-01-03', limit: 10 })).toMatchObject({ present: false, records: [], omitted: 0 });
  });

  it('rejects a date that is not a day, since it becomes part of a file name', () => {
    expect(() => readLogRecords(configDir, { date: '../x', limit: 10 })).toThrow(/YYYY-MM-DD/);
  });
});
