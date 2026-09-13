import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLogger } from './EventLogger.js';

function readRecords(logsDir: string): Record<string, unknown>[] {
  const today = new Date().toISOString().slice(0, 10);
  const content = readFileSync(join(logsDir, `${today}.ndjson`), 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('EventLogger', () => {
  let logsDir: string;
  let logger: EventLogger;

  beforeEach(() => {
    logsDir = join(tmpdir(), `queue-logger-test-${crypto.randomUUID()}`);
    mkdirSync(logsDir, { recursive: true });
    logger = new EventLogger(logsDir);
  });

  afterEach(() => {
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
});
