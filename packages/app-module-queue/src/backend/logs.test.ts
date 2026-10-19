import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogs, DEFAULT_LOG_LINES, MAX_LOG_LINES } from './logs.js';
import { InvalidQueryError } from './errors.js';

let configDir: string;

function writeLog(date: string, count: number): void {
  mkdirSync(join(configDir, 'logs'), { recursive: true });
  const records = Array.from({ length: count }, (_, i) => ({
    ts: `${date}T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
    type: 'diagnostic',
    source: 'test',
    message: `m${i}`,
  }));
  writeFileSync(join(configDir, 'logs', `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-logs-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('getLogs', () => {
  it('returns the last records of the asked day as rows, newest first, rendered like `queue logs`', () => {
    writeLog('2026-10-18', 3);
    const response = getLogs(configDir, { date: '2026-10-18', limit: '2' });
    expect(response).toEqual({
      date: '2026-10-18',
      present: true,
      omitted: 1,
      lines: [{ text: '[10:00:02] [info] test: m2' }, { text: '[10:00:01] [info] test: m1' }],
    });
  });

  it(`shows at most ${DEFAULT_LOG_LINES} records when no limit is given`, () => {
    writeLog('2026-10-18', DEFAULT_LOG_LINES + 5);
    const response = getLogs(configDir, { date: '2026-10-18' });
    expect(response.lines).toHaveLength(DEFAULT_LOG_LINES);
    expect(response.omitted).toBe(5);
  });

  it('a day without a log file answers present: false, not an error', () => {
    expect(getLogs(configDir, { date: '2026-01-01' })).toMatchObject({ date: '2026-01-01', present: false, lines: [], omitted: 0 });
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
  ])('rejects %j with an actionable InvalidQueryError', (query, message) => {
    expect(() => getLogs(configDir, query)).toThrowError(InvalidQueryError);
    expect(() => getLogs(configDir, query)).toThrowError(message);
  });
});
