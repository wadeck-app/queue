import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLogger } from './EventLogger.js';
import type { PruneOptions, PruneReport } from './LogRetention.js';

function readRecords(logsDir: string): Record<string, unknown>[] {
  const today = new Date().toISOString().slice(0, 10);
  const content = readFileSync(join(logsDir, `${today}.ndjson`), 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line): Record<string, unknown> => JSON.parse(line));
}

describe('EventLogger', () => {
  let logsDir: string;
  let logger: EventLogger;

  beforeEach(() => {
    // The code under test reads the clock to name the day file: pin it so a run across midnight cannot split the day
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    logsDir = join(tmpdir(), `queue-logger-test-${crypto.randomUUID()}`);
    mkdirSync(logsDir, { recursive: true });
    logger = new EventLogger(logsDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(logsDir, { recursive: true, force: true });
  });

  it('logDispatch persists stdout and stderr of a failed dispatch', () => {
    logger.logDispatch({
      event: 'onTest',
      subscriberId: 'onTest[0]',
      status: 'failed',
      target: 'my-cli run',
      durationMs: 12,
      error: 'exited with code 3',
      attempts: 1,
      stdout: 'partial output',
      stderr: "Cannot find module 'extension-points/extension-points.json'",
    });

    const records = readRecords(logsDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'dispatch',
      status: 'failed',
      error: 'exited with code 3',
      stdout: 'partial output',
      stderr: "Cannot find module 'extension-points/extension-points.json'",
    });
    expect(typeof records[0]!['ts']).toBe('string');
  });

  it('logFilterMiss persists the looked-up path, expected and actual values', () => {
    logger.logFilterMiss({
      event: 'onTest',
      subscriberId: 'onTest[1]',
      filter: 'payload.exitCode=1',
      reason: 'value mismatch',
      path: 'payload.exitCode',
      expected: '1',
      actual: '0',
    });

    expect(readRecords(logsDir)[0]).toMatchObject({
      type: 'filter-miss',
      filter: 'payload.exitCode=1',
      reason: 'value mismatch',
      path: 'payload.exitCode',
      expected: '1',
      actual: '0',
    });
  });

  it('logDiagnostic persists source and message', () => {
    logger.logDiagnostic({ source: 'AsyncDispatcher', message: 'no WAL entry for subscriber onTest[0]' });

    expect(readRecords(logsDir)[0]).toMatchObject({
      type: 'diagnostic',
      source: 'AsyncDispatcher',
      message: 'no WAL entry for subscriber onTest[0]',
    });
  });

  it('creates the logs directory when missing', () => {
    const nestedDir = join(logsDir, 'nested', 'logs');
    new EventLogger(nestedDir).logDiagnostic({ source: 'test', message: 'created' });
    expect(readRecords(nestedDir)).toHaveLength(1);
  });

  it('appends one record per call', () => {
    logger.logDiagnostic({ source: 'test', message: 'first' });
    logger.logDiagnostic({ source: 'test', message: 'second' });
    expect(readRecords(logsDir).map(r => r['message'])).toEqual(['first', 'second']);
  });

  describe('log retention', () => {
    const emptyReport: PruneReport = { deleted: [], failures: [], remainingBytes: 0 };

    it('runs once on the first write of a new day and not on the next writes', () => {
      const calls: { dir: string; options: PruneOptions }[] = [];
      const spied = new EventLogger(logsDir, (dir, options) => {
        calls.push({ dir, options });
        return emptyReport;
      });

      spied.logDiagnostic({ source: 'test', message: 'one' });
      spied.logDiagnostic({ source: 'test', message: 'two' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.dir).toBe(logsDir);
      expect(calls[0]!.options.keepDay).toBe('2026-10-19');
      expect(calls[0]!.options.now.toISOString()).toBe('2026-10-19T12:00:00.000Z');

      vi.setSystemTime(new Date('2026-10-20T00:00:01.000Z'));
      spied.logDiagnostic({ source: 'test', message: 'next day' });
      spied.logDiagnostic({ source: 'test', message: 'next day again' });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.options.keepDay).toBe('2026-10-20');
    });

    it('does not run when the file of the day already exists, even for a fresh process', () => {
      writeFileSync(join(logsDir, '2026-10-19.ndjson'), '');
      let count = 0;
      new EventLogger(logsDir, () => {
        count++;
        return emptyReport;
      }).logDiagnostic({ source: 'test', message: 'x' });
      expect(count).toBe(0);
    });

    it('logs one info line for what was deleted and a warn line for a warning or a failure', () => {
      const report: PruneReport = {
        deleted: [{ file: '2020-01-01.ndjson', bytes: 1234, reason: 'older than 90 days' }],
        failures: [{ file: '2020-01-02.ndjson', error: 'EBUSY', fix: 'close it' }],
        remainingBytes: 5,
        warning: 'too big',
      };
      new EventLogger(logsDir, () => report).logDiagnostic({ source: 'test', message: 'first' });

      const records = readRecords(logsDir);
      expect(records.map(r => r['message'])).toHaveLength(3);
      expect(records[0]!['message']).toBe('first');
      expect(records[1]).toMatchObject({ source: 'LogRetention', level: 'info' });
      expect(records[1]!['message']).toContain('2020-01-01.ndjson (older than 90 days)');
      expect(records[1]!['message']).toContain('1234 bytes freed');
      expect(records[2]).toMatchObject({ source: 'LogRetention', level: 'warn' });
      expect(records[2]!['message']).toContain('too big');
      expect(records[2]!['message']).toContain('EBUSY. close it');
    });

    it('writes nothing extra when nothing was deleted', () => {
      new EventLogger(logsDir, () => emptyReport).logDiagnostic({ source: 'test', message: 'first' });
      expect(readRecords(logsDir)).toHaveLength(1);
    });

    it('still writes the record when the retention throws, and says so in a warn line', () => {
      new EventLogger(logsDir, () => {
        throw new Error('EPERM: scandir');
      }).logDiagnostic({ source: 'test', message: 'first' });

      const records = readRecords(logsDir);
      expect(records[0]!['message']).toBe('first');
      expect(records[1]).toMatchObject({ level: 'warn' });
      expect(records[1]!['message']).toContain('EPERM: scandir');
    });

    it('prunes real old files with the default retention on a new day', () => {
      // The test clock is pinned to 2026-10-19 while a file written now gets the real mtime (later than that): set the mtime explicitly, far in the past
      const longAgo = new Date('2020-01-01T00:00:00.000Z');
      writeFileSync(join(logsDir, '2020-01-01.ndjson'), 'old');
      utimesSync(join(logsDir, '2020-01-01.ndjson'), longAgo, longAgo);
      // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
      writeFileSync(join(logsDir, '2026-10-18.ndjson'), 'yesterday');
      utimesSync(join(logsDir, '2026-10-18.ndjson'), longAgo, longAgo);
      logger.logDiagnostic({ source: 'test', message: 'first' });
      expect(readRecords(logsDir).some(r => String(r['message']).includes('2020-01-01.ndjson'))).toBe(true);
    });
  });
});
