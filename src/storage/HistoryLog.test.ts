import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
      actual: '1',
    });

    expect(readRecords(historyDir)[0]).toMatchObject({
      type: 'filtered',
      eventId: 'ev-1',
      subscriberId: 'onTicket.created[1]',
      filter: 'payload.exitCode=0',
      actual: '1',
    });
  });

  it('logTrigger persists the payload and replayOf, for `queue replay` to resubmit later', () => {
    history.logTrigger({
      eventId: 'ev-2',
      event: 'onTicket.created',
      matchedCount: 1,
      totalCount: 1,
      payload: { title: 'original' },
      replayOf: 'ev-1',
    });

    expect(readRecords(historyDir)[0]).toMatchObject({
      type: 'trigger',
      eventId: 'ev-2',
      payload: { title: 'original' },
      replayOf: 'ev-1',
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

  describe('retention (payloads must not accumulate forever -- see threat-model.md)', () => {
    it('deletes day files older than the retention window on write', () => {
      writeFileSync(join(historyDir, '2020-01-01.ndjson'), '{}\n', 'utf-8');
      writeFileSync(join(historyDir, '2020-01-02.ndjson'), '{}\n', 'utf-8');

      new HistoryLog(historyDir, 7).logTrigger({ eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 });

      expect(existsSync(join(historyDir, '2020-01-01.ndjson'))).toBe(false);
      expect(existsSync(join(historyDir, '2020-01-02.ndjson'))).toBe(false);
    });

    it('keeps day files within the retention window', () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      writeFileSync(join(historyDir, `${yesterday}.ndjson`), '{}\n', 'utf-8');

      new HistoryLog(historyDir, 30).logTrigger({ eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 });

      expect(existsSync(join(historyDir, `${yesterday}.ndjson`))).toBe(true);
      expect(existsSync(join(historyDir, `${today}.ndjson`))).toBe(true);
    });

    it('ignores non-day-file entries in the history directory', () => {
      writeFileSync(join(historyDir, 'not-a-day-file.txt'), 'irrelevant', 'utf-8');

      new HistoryLog(historyDir, 7).logTrigger({ eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 });

      expect(existsSync(join(historyDir, 'not-a-day-file.txt'))).toBe(true);
      expect(readdirSync(historyDir)).toContain('not-a-day-file.txt');
    });

    it('defaults to a 30-day retention window', () => {
      writeFileSync(join(historyDir, '2020-01-01.ndjson'), '{}\n', 'utf-8');

      new HistoryLog(historyDir).logTrigger({ eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 });

      expect(existsSync(join(historyDir, '2020-01-01.ndjson'))).toBe(false);
    });
  });
});
