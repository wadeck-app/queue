import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryLog } from './HistoryLog.js';
import { pruneLogDir, type RetentionLine } from './LogRetention.js';

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
    // The code under test reads the clock to name the day file: pin it so a run across midnight cannot split the day
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    historyDir = join(tmpdir(), `queue-history-test-${crypto.randomUUID()}`);
    mkdirSync(historyDir, { recursive: true });
    history = new HistoryLog(historyDir);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('logTrigger persists causedBy for an event emitted by an action', () => {
    history.logTrigger({ eventId: 'ev-4', event: 'agent.message', matchedCount: 0, totalCount: 0, causedBy: { eventId: 'ev-3', subscriberId: 'p/wake' } });

    expect(readRecords(historyDir)[0]).toMatchObject({ type: 'trigger', eventId: 'ev-4', causedBy: { eventId: 'ev-3', subscriberId: 'p/wake' } });
  });

  it('logTrigger persists the cwd from the original push, for `queue replay` to reuse it', () => {
    history.logTrigger({
      eventId: 'ev-3',
      event: 'onTicket.created',
      matchedCount: 1,
      totalCount: 1,
      cwd: '/home/user/project',
    });

    const record = readRecords(historyDir)[0]!;
    expect(record['type']).toBe('trigger');
    expect(record['eventId']).toBe('ev-3');
    expect(record['cwd']).toBe('/home/user/project');
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
    const trigger = { eventId: 'ev-1', event: 'onTest', matchedCount: 0, totalCount: 0 };
    const put = (name: string, bytes = 10): void => writeFileSync(join(historyDir, name), 'x'.repeat(bytes), 'utf-8');

    it('deletes day files older than 90 days when the file of a new day is created (90 days kept, 91 deleted)', () => {
      // 2026-10-19 minus 90 days is 2026-07-21
      put('2026-07-21.ndjson');
      put('2026-07-20.ndjson');
      put('2020-01-01.ndjson');

      new HistoryLog(historyDir, () => undefined).logTrigger(trigger);

      expect(readdirSync(historyDir).sort()).toEqual(['2026-07-21.ndjson', '2026-10-19.ndjson']);
    });

    it('keeps recent day files', () => {
      put('2026-10-18.ndjson');
      history.logTrigger(trigger);
      expect(existsSync(join(historyDir, '2026-10-18.ndjson'))).toBe(true);
      expect(existsSync(join(historyDir, '2026-10-19.ndjson'))).toBe(true);
    });

    it('ignores non-day-file entries in the history directory', () => {
      put('not-a-day-file.txt');
      put('2020-01-01.ndjson.bak');
      put('2020-01-01-launcher.log');

      history.logTrigger(trigger);

      expect(readdirSync(historyDir).sort()).toEqual(['2020-01-01-launcher.log', '2020-01-01.ndjson.bak', '2026-10-19.ndjson', 'not-a-day-file.txt']);
    });

    it('runs once, on the first write of a new day, and not on the following writes', () => {
      const prune = vi.fn(() => ({ deleted: [], failures: [], remainingBytes: 0 }));
      const log = new HistoryLog(historyDir, () => undefined, prune);

      log.logTrigger(trigger);
      log.logOutcome({ eventId: 'ev-1', event: 'onTest', subscriberId: 's', status: 'success' });
      log.logFiltered({ eventId: 'ev-1', event: 'onTest', subscriberId: 't', filter: 'f' });
      expect(prune).toHaveBeenCalledTimes(1);
      expect(prune).toHaveBeenCalledWith(historyDir, { kind: 'history', now: new Date('2026-10-19T12:00:00.000Z'), keepDay: '2026-10-19' });

      // The next day: a new file, so one more run
      vi.setSystemTime(new Date('2026-10-20T00:00:01.000Z'));
      log.logTrigger(trigger);
      log.logTrigger(trigger);
      expect(prune).toHaveBeenCalledTimes(2);
    });

    it('reports what it deleted, whole days oldest first, through onRetention', () => {
      // The default cap is 200 MB: use an injected prune to exercise the report path with a small cap
      put('2026-10-10.ndjson', 40);
      put('2026-10-11.ndjson', 40);
      const received: RetentionLine[][] = [];
      const log = new HistoryLog(historyDir, lines => received.push(lines), (dir, options) => pruneLogDir(dir, { ...options, maxTotalBytes: 50 }));

      log.logTrigger(trigger);

      expect(readdirSync(historyDir).sort()).toEqual(['2026-10-11.ndjson', '2026-10-19.ndjson']);
      expect(received).toHaveLength(1);
      expect(received[0]![0]!.level).toBe('info');
      expect(received[0]![0]!.message).toBe('History retention deleted 1 file(s), 40 bytes freed: 2026-10-10.ndjson (total size over 0 MB)');
    });

    it('does not report when there is nothing to say', () => {
      const onRetention = vi.fn();
      put('2026-10-18.ndjson');
      new HistoryLog(historyDir, onRetention).logTrigger(trigger);
      expect(onRetention).not.toHaveBeenCalled();
    });

    it('still writes the record, and reports the failure with a fix, when a file cannot be deleted', () => {
      // A directory named like a day file cannot be unlinked, on Windows and POSIX alike
      mkdirSync(join(historyDir, '2020-01-01.ndjson'));
      const received: RetentionLine[][] = [];

      new HistoryLog(historyDir, lines => received.push(lines)).logTrigger(trigger);

      expect(readRecords(historyDir)).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received[0]![0]!.level).toBe('warn');
      expect(received[0]![0]!.message).toContain('2020-01-01.ndjson');
      expect(received[0]![0]!.message).toContain('delete it by hand');
    });

    it('still writes the record, and says how to fix it, when the retention itself throws', () => {
      const received: RetentionLine[][] = [];
      const log = new HistoryLog(historyDir, lines => received.push(lines), () => {
        throw new Error('EACCES: permission denied');
      });

      log.logTrigger(trigger);

      expect(readRecords(historyDir)).toHaveLength(1);
      expect(received[0]![0]!.message).toContain('EACCES: permission denied');
      expect(received[0]![0]!.message).toContain(historyDir);
    });

    it('still writes the record when the report channel throws too', () => {
      mkdirSync(join(historyDir, '2020-01-01.ndjson'));
      new HistoryLog(historyDir, () => {
        throw new Error('channel down');
      }).logTrigger(trigger);
      expect(readRecords(historyDir)).toHaveLength(1);
    });

    it('writes to stderr by default, never silently', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      mkdirSync(join(historyDir, '2020-01-01.ndjson'));
      try {
        new HistoryLog(historyDir).logTrigger(trigger);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining('History retention: 2020-01-01.ndjson'));
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
