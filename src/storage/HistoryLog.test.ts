import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryLog } from './HistoryLog.js';

function readRecords(historyDir: string): Record<string, unknown>[] {
  const today = new Date().toISOString().slice(0, 10);
  const content = readFileSync(join(historyDir, `${today}.ndjson`), 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line): Record<string, unknown> => JSON.parse(line));
}

describe('HistoryLog', () => {
  let historyDir: string;
  let history: HistoryLog;

  beforeEach(() => {
    historyDir = join(tmpdir(), `queue-history-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
    history = new HistoryLog(historyDir);
  });

  afterEach(() => {
    rmSync(historyDir, { recursive: true, force: true });
  });

  it('logTrigger persists event, matched/total counts and project', () => {
    history.logTrigger({ eventId: 'ev-1', event: 'onTicket.created', project: 'queue', matchedCount: 2, totalCount: 3 });

    const records = readRecords(historyDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'trigger',
      eventId: 'ev-1',
      event: 'onTicket.created',
      project: 'queue',
      matchedCount: 2,
      totalCount: 3,
    });
    expect(typeof records[0]!['ts']).toBe('string');
  });

  it('logOutcome persists eventId, subscriberId, status and target, without stdout/stderr fields', () => {
    history.logOutcome({ eventId: 'ev-1', event: 'onTicket.created', subscriberId: 'onTicket.created[0]', status: 'success', target: 'echo ok' });

    const record = readRecords(historyDir)[0]!;
    expect(record).toMatchObject({ type: 'outcome', eventId: 'ev-1', subscriberId: 'onTicket.created[0]', status: 'success', target: 'echo ok' });
    expect(record['stdout']).toBeUndefined();
    expect(record['stderr']).toBeUndefined();
  });

  it('logFiltered persists eventId, subscriberId and filter detail', () => {
    history.logFiltered({
      eventId: 'ev-1',
      event: 'onTicket.created',
      subscriberId: 'onTicket.created[1]',
      filter: 'payload.exitCode=0',
      path: 'payload.exitCode',
      expected: '0',
      actual: '1',
    });

    expect(readRecords(historyDir)[0]).toMatchObject({
      type: 'filtered',
      eventId: 'ev-1',
      subscriberId: 'onTicket.created[1]',
      filter: 'payload.exitCode=0',
      path: 'payload.exitCode',
      expected: '0',
      actual: '1',
    });
  });

  it('creates the history directory when missing', () => {
    const nestedDir = join(historyDir, 'nested', 'history');
    new HistoryLog(nestedDir).logTrigger({ eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 });
    expect(readRecords(nestedDir)).toHaveLength(1);
  });

  it('appends one record per call, correlated by eventId', () => {
    history.logTrigger({ eventId: 'ev-1', event: 'onTicket.created', matchedCount: 1, totalCount: 1 });
    history.logOutcome({ eventId: 'ev-1', event: 'onTicket.created', subscriberId: 'onTicket.created[0]', status: 'success' });

    const records = readRecords(historyDir);
    expect(records).toHaveLength(2);
    expect(records.every(r => r['eventId'] === 'ev-1')).toBe(true);
  });
});
