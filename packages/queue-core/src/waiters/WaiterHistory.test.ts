import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PruneOptions, PruneReport } from '../storage/LogRetention.js';
import { WaiterHistoryLog, type WaiterEndRecord } from './WaiterHistory.js';
import { WAITER_RECORD_VERSION, type WaiterRecord } from './WaiterRecord.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'waiter-history-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const record: WaiterRecord = {
  v: WAITER_RECORD_VERSION,
  id: 'id-1',
  name: 'a.b',
  events: ['onX'],
  whens: ['payload.a=1'],
  label: 'L',
  contact: { kind: 'none' },
  pid: 77,
  cwd: '/p',
  since: '2026-11-08T09:00:00.000Z',
  startedAt: '2026-11-08T10:00:00.000Z',
};
const end: WaiterEndRecord = { kind: 'end', id: 'id-1', name: 'a.b', endedAt: '2026-11-08T10:05:00.000Z', durationMs: 300_000, outcome: 'matched', eventId: 'e-1', event: 'onX' };

function lines(file: string): unknown[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as unknown);
}

describe('WaiterHistoryLog', () => {
  it('writes the start record with the fields of the register, in the file of the UTC day', () => {
    const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T23:59:59.000Z') });
    log.recordStart(record);
    expect(readdirSync(dir)).toEqual(['2026-11-08.ndjson']);
    expect(lines(join(dir, '2026-11-08.ndjson'))).toEqual([
      { kind: 'start', id: 'id-1', name: 'a.b', events: ['onX'], whens: ['payload.a=1'], label: 'L', contact: { kind: 'none' }, pid: 77, cwd: '/p', since: '2026-11-08T09:00:00.000Z', startedAt: '2026-11-08T10:00:00.000Z' },
    ]);
  });

  it('writes the end record as given', () => {
    const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T10:05:00.000Z') });
    log.recordEnd(end);
    expect(lines(join(dir, '2026-11-08.ndjson'))).toEqual([end]);
  });

  it('the file is the day of the write, not the day in the record (a lost record about yesterday goes to today)', () => {
    const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-09T00:00:01.000Z') });
    log.recordEnd({ ...end, outcome: 'lost', endedAt: '2026-11-08T23:59:00.000Z' });
    expect(readdirSync(dir)).toEqual(['2026-11-09.ndjson']);
  });

  it('runs the retention once when it creates the file of a day, not at each write', () => {
    const calls: PruneOptions[] = [];
    const prune = (_dir: string, options: PruneOptions): PruneReport => {
      calls.push(options);
      return { deleted: [], failures: [], remainingBytes: 0 };
    };
    const clock = { now: new Date('2026-11-08T10:00:00.000Z') };
    const log = new WaiterHistoryLog(dir, { now: () => clock.now, prune });
    log.recordStart(record);
    log.recordEnd(end);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'history', keepDay: '2026-11-08' });
    clock.now = new Date('2026-11-09T10:00:00.000Z');
    log.recordEnd(end);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ keepDay: '2026-11-09' });
  });

  it('keeps 90 days by default, through the shared retention: an older day file is deleted when a new day starts', () => {
    writeFileSync(join(dir, '2026-01-01.ndjson'), '{}\n');
    writeFileSync(join(dir, '2026-10-01.ndjson'), '{}\n');
    // a file modified after the clock of the test is protected as possibly open: these are old files
    for (const name of ['2026-01-01.ndjson', '2026-10-01.ndjson']) utimesSync(join(dir, name), new Date('2026-11-01T00:00:00.000Z'), new Date('2026-11-01T00:00:00.000Z'));
    const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T10:00:00.000Z'), onRetention: () => undefined });
    log.recordStart(record);
    expect(readdirSync(dir).sort()).toEqual(['2026-10-01.ndjson', '2026-11-08.ndjson']);
  });

  it('a retention that throws never loses the record, and its failure is passed on naming the folder', () => {
    const said: string[] = [];
    const log = new WaiterHistoryLog(dir, {
      now: () => new Date('2026-11-08T10:00:00.000Z'),
      prune: () => { throw new Error('disk on fire'); },
      onRetention: (found) => { said.push(...found.map((line) => line.message)); },
    });
    log.recordStart(record);
    expect(lines(join(dir, '2026-11-08.ndjson'))).toHaveLength(1);
    expect(said.join(' ')).toContain('disk on fire');
    expect(said.join(' ')).toContain(dir);
  });

  it('a retention report is passed on', () => {
    const said: string[] = [];
    const log = new WaiterHistoryLog(dir, {
      now: () => new Date('2026-11-08T10:00:00.000Z'),
      prune: () => ({ deleted: [{ file: '2026-01-01.ndjson', bytes: 10, reason: 'older than 90 days' }], failures: [], remainingBytes: 0 }),
      onRetention: (found) => { said.push(...found.map((line) => line.message)); },
    });
    log.recordStart(record);
    expect(said.join(' ')).toContain('2026-01-01.ndjson');
    expect(said.join(' ')).toContain('Waits history');
  });

  it('heals a torn tail: the new record is on its own line', () => {
    writeFileSync(join(dir, '2026-11-08.ndjson'), '{"kind":"start","id":"cut');
    const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T10:00:00.000Z') });
    log.recordEnd(end);
    const text = readFileSync(join(dir, '2026-11-08.ndjson'), 'utf8').split('\n');
    expect(text[0]).toBe('{"kind":"start","id":"cut');
    expect(JSON.parse(text[1]!)).toEqual(end);
  });

  it('creates the folder on the first write', () => {
    const nested = join(dir, 'waiters', 'history');
    new WaiterHistoryLog(nested, { now: () => new Date('2026-11-08T10:00:00.000Z') }).recordStart(record);
    expect(readdirSync(nested)).toEqual(['2026-11-08.ndjson']);
  });

  describe('hasEnd', () => {
    it('finds an end by id in the files from the day of the start to today', () => {
      const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-09T10:00:00.000Z') });
      log.recordEnd(end);
      expect(log.hasEnd('id-1', '2026-11-08T10:00:00.000Z')).toBe(true);
      expect(log.hasEnd('id-2', '2026-11-08T10:00:00.000Z')).toBe(false);
    });

    it('does not read the files of days before the start', () => {
      new WaiterHistoryLog(dir, { now: () => new Date('2026-11-05T10:00:00.000Z') }).recordEnd(end);
      const later = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-09T10:00:00.000Z') });
      expect(later.hasEnd('id-1', '2026-11-08T10:00:00.000Z')).toBe(false);
    });

    it('does not read the files of days after today', () => {
      new WaiterHistoryLog(dir, { now: () => new Date('2026-11-12T10:00:00.000Z') }).recordEnd(end);
      const earlier = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-09T10:00:00.000Z') });
      expect(earlier.hasEnd('id-1', '2026-11-08T10:00:00.000Z')).toBe(false);
    });

    it('an end of another wait that mentions the id elsewhere in the line is not this wait\'s end', () => {
      const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T10:00:00.000Z') });
      log.recordEnd({ ...end, id: 'other', eventId: 'id-1' });
      expect(log.hasEnd('id-1', record.startedAt)).toBe(false);
    });

    it('a start with the same id is not an end', () => {
      const log = new WaiterHistoryLog(dir, { now: () => new Date('2026-11-08T10:00:00.000Z') });
      log.recordStart(record);
      expect(log.hasEnd('id-1', record.startedAt)).toBe(false);
    });

    it('a torn line and a missing folder are not errors', () => {
      const clock = () => new Date('2026-11-08T10:00:00.000Z');
      expect(new WaiterHistoryLog(join(dir, 'none'), { now: clock }).hasEnd('id-1', record.startedAt)).toBe(false);
      writeFileSync(join(dir, '2026-11-08.ndjson'), '{"kind":"en');
      expect(new WaiterHistoryLog(dir, { now: clock }).hasEnd('id-1', record.startedAt)).toBe(false);
    });
  });
});
