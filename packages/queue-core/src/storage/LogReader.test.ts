import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogTail, logFilePath } from './LogReader.js';

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
