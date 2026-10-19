import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogTail, logFilePath, readDispatchDurations } from './LogReader.js';

let configDir: string;
const NOW = () => new Date('2026-10-19T12:00:00.000Z');

function writeLog(date: string, records: object[]): void {
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  writeFileSync(logFilePath(configDir, date), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const diagnostic = (n: number) => ({ ts: `2026-10-19T10:00:0${n}.000Z`, type: 'diagnostic', source: 'test', message: `m${n}` });

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'log-reader-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('readLogTail', () => {
  it('reads today (UTC) by default, rendered like `queue logs`', () => {
    writeLog('2026-10-19', [diagnostic(1), diagnostic(2)]);
    const tail = readLogTail(configDir, { limit: 10, now: NOW });
    expect(tail.date).toBe('2026-10-19');
    expect(tail.present).toBe(true);
    expect(tail.lines).toEqual(['[10:00:01] [info] test: m1', '[10:00:02] [info] test: m2']);
    expect(tail.omitted).toBe(0);
  });

  it('keeps the last `limit` records and says how many it left out', () => {
    writeLog('2026-10-19', [diagnostic(1), diagnostic(2), diagnostic(3)]);
    const tail = readLogTail(configDir, { limit: 2, now: NOW });
    expect(tail.lines).toEqual(['[10:00:02] [info] test: m2', '[10:00:03] [info] test: m3']);
    expect(tail.omitted).toBe(1);
  });

  it('reads another day when asked', () => {
    writeLog('2026-10-18', [diagnostic(1)]);
    expect(readLogTail(configDir, { limit: 10, date: '2026-10-18', now: NOW }).lines).toHaveLength(1);
  });

  it('a day without a file is present: false with no lines, not an error', () => {
    const tail = readLogTail(configDir, { limit: 10, now: NOW });
    expect(tail).toMatchObject({ present: false, lines: [], omitted: 0, bytes: 0 });
    expect(tail.file).toBe(logFilePath(configDir, '2026-10-19'));
  });

  it('reports the size read, so a follower can continue from there', () => {
    writeLog('2026-10-19', [diagnostic(1)]);
    const tail = readLogTail(configDir, { limit: 10, now: NOW });
    expect(tail.bytes).toBe(Buffer.byteLength(JSON.stringify(diagnostic(1)) + '\n', 'utf8'));
  });

  it('refuses a date that is not YYYY-MM-DD, so it can never leave the logs folder', () => {
    for (const date of ['../wal', '2026-10-19/../../x', 'today', '2026-1-1', '']) {
      expect(() => readLogTail(configDir, { limit: 10, date, now: NOW })).toThrowError(/YYYY-MM-DD/);
    }
  });
});

describe('readDispatchDurations', () => {
  const NOW = Date.parse('2026-10-19T12:00:00.000Z');
  const HOUR = 3_600_000;
  const dispatch = (atMs: number, subscriberId: string, durationMs?: number) => ({
    ts: new Date(atMs).toISOString(), type: 'dispatch', event: 'onFoo', subscriberId, status: 'success', ...(durationMs === undefined ? {} : { durationMs }),
  });

  it('totals the runs, time and slowest run of each subscriber inside the window, across the two days it spans', () => {
    writeLog('2026-10-19', [dispatch(NOW - HOUR, 'a[0]', 100), dispatch(NOW - 2 * HOUR, 'a[0]', 300), dispatch(NOW - HOUR, 'b[0]', 50)]);
    writeLog('2026-10-18', [dispatch(NOW - 20 * HOUR, 'a[0]', 200), dispatch(NOW - 30 * HOUR, 'a[0]', 9999)]);
    const durations = readDispatchDurations(configDir, NOW, 24 * HOUR);
    expect(Object.fromEntries(durations)).toEqual({
      'a[0]': { runs: 3, totalMs: 600, maxMs: 300 },
      'b[0]': { runs: 1, totalMs: 50, maxMs: 50 },
    });
  });

  it('skips records without a duration, other record types, unreadable lines and what is in the future', () => {
    mkdirSync(join(configDir, 'logs'), { recursive: true });
    writeFileSync(logFilePath(configDir, '2026-10-19'), [
      JSON.stringify(dispatch(NOW - HOUR, 'a[0]')),
      JSON.stringify({ ts: new Date(NOW - HOUR).toISOString(), type: 'diagnostic', source: 's', message: 'm' }),
      '{"type":"dispatch" broken',
      JSON.stringify(dispatch(NOW + HOUR, 'a[0]', 10)),
      JSON.stringify(dispatch(NOW - HOUR, 'a[0]', 10)),
    ].join('\n') + '\n');
    expect(Object.fromEntries(readDispatchDurations(configDir, NOW, 24 * HOUR))).toEqual({ 'a[0]': { runs: 1, totalMs: 10, maxMs: 10 } });
  });

  it('is empty when there is no log in the window', () => {
    expect(readDispatchDurations(configDir, NOW, 24 * HOUR).size).toBe(0);
  });
});
