import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneLogDir, describeRetention, LOG_MAX_AGE_DAYS, LOG_MAX_TOTAL_BYTES, HISTORY_MAX_AGE_DAYS, HISTORY_MAX_TOTAL_BYTES, type PruneOptions, type PruneReport } from './LogRetention.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const TODAY = '2026-10-19';

describe('pruneLogDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, bytes = 10): void => writeFileSync(join(dir, name), 'x'.repeat(bytes));
  const names = (): string[] => readdirSync(dir).sort();

  it('exports the policy constants', () => {
    expect(LOG_MAX_AGE_DAYS).toBe(90);
    expect(LOG_MAX_TOTAL_BYTES).toBe(100 * 1024 * 1024);
  });

  it('cuts by the date in the name (90 days kept, 91 deleted), both file kinds, whatever the mtime', () => {
    // 2026-10-19 minus 90 days is 2026-07-21
    put('2026-07-21.ndjson');
    put('2026-07-20.ndjson', 7);
    put('2026-07-20-launcher.log', 5);
    put(`${TODAY}.ndjson`);

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY });

    expect(names()).toEqual(['2026-07-21.ndjson', `${TODAY}.ndjson`]);
    expect([...report.deleted].sort((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: '2026-07-20-launcher.log', bytes: 5, reason: 'older than 90 days' },
      { file: '2026-07-20.ndjson', bytes: 7, reason: 'older than 90 days' },
    ]);
    expect(report.remainingBytes).toBe(20);
    expect(report.warning).toBeUndefined();
    expect(report.failures).toEqual([]);
  });

  it('deletes whole days oldest first, the ndjson and the launcher log together, until under the cap', () => {
    put('2026-10-10.ndjson', 40);
    put('2026-10-10-launcher.log', 10);
    put('2026-10-11.ndjson', 40);
    put('2026-10-11-launcher.log', 10);
    put('2026-10-12.ndjson', 40);
    put(`${TODAY}.ndjson`, 20);

    // total 160, cap 100: day 10 (50) leaves 110, day 11 (50) leaves 60
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });

    expect(names()).toEqual(['2026-10-12.ndjson', `${TODAY}.ndjson`]);
    expect(report.deleted).toHaveLength(4);
    expect(report.deleted.every(d => d.reason === 'total size over 0 MB')).toBe(true);
    expect(report.remainingBytes).toBe(60);
    expect(report.warning).toBeUndefined();
  });

  it('stops deleting as soon as the total is at the cap', () => {
    put('2026-10-10.ndjson', 50);
    put('2026-10-11.ndjson', 50);
    put(`${TODAY}.ndjson`, 50);
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });
    expect(names()).toEqual(['2026-10-11.ndjson', `${TODAY}.ndjson`]);
    expect(report.remainingBytes).toBe(100);
  });

  it('never deletes keepDay and warns when it alone is over the cap', () => {
    put('2026-10-10.ndjson', 10);
    put(`${TODAY}.ndjson`, 80);
    put(`${TODAY}-launcher.log`, 80);

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });

    expect(names()).toEqual([`${TODAY}-launcher.log`, `${TODAY}.ndjson`]);
    expect(report.deleted.map(d => d.file)).toEqual(['2026-10-10.ndjson']);
    expect(report.remainingBytes).toBe(160);
    expect(report.warning).toContain(TODAY);
    expect(report.warning).toContain('queue logs');
  });

  it('never touches a file that does not match the log names', () => {
    put('2020-01-01.ndjson.bak');
    put('notes.txt');
    put('2020-01-01-other.log');
    put('2020-01-01.txt');
    put('wal.ndjson');
    const before = names();

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 1 });

    expect(names()).toEqual(before);
    expect(report.deleted).toEqual([]);
    expect(report.remainingBytes).toBe(0);
  });

  it('reports an unlink failure with its message and a fix, without throwing, and goes on', () => {
    // A directory named like a log file cannot be unlinked, on Windows and POSIX alike
    mkdirSync(join(dir, '2020-01-01.ndjson'));
    put('2020-01-02.ndjson', 3);

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY });

    expect(existsSync(join(dir, '2020-01-01.ndjson'))).toBe(true);
    expect(existsSync(join(dir, '2020-01-02.ndjson'))).toBe(false);
    expect(report.deleted.map(d => d.file)).toEqual(['2020-01-02.ndjson']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.file).toBe('2020-01-01.ndjson');
    expect(report.failures[0]!.error.length).toBeGreaterThan(0);
    expect(report.failures[0]!.fix).toContain('delete it by hand');
  });
});

describe('pruneLogDir for the history directory', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-history-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, bytes = 10): void => writeFileSync(join(dir, name), 'x'.repeat(bytes));
  const names = (): string[] => readdirSync(dir).sort();
  const prune = (extra: Partial<PruneOptions> = {}): PruneReport => pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY, ...extra });

  it('exports the policy constants', () => {
    expect(HISTORY_MAX_AGE_DAYS).toBe(90);
    expect(HISTORY_MAX_TOTAL_BYTES).toBe(200 * 1024 * 1024);
  });

  it('cuts by the date in the name (90 days kept, 91 deleted), whatever the mtime', () => {
    put('2026-07-21.ndjson');
    put('2026-07-20.ndjson', 7);
    put(`${TODAY}.ndjson`);

    const report = prune();

    expect(names()).toEqual(['2026-07-21.ndjson', `${TODAY}.ndjson`]);
    expect(report.deleted).toEqual([{ file: '2026-07-20.ndjson', bytes: 7, reason: 'older than 90 days' }]);
    expect(report.warning).toBeUndefined();
  });

  it('deletes whole days oldest first until under the cap, with the size reason', () => {
    put('2026-10-10.ndjson', 40);
    put('2026-10-11.ndjson', 40);
    put('2026-10-12.ndjson', 40);
    put(`${TODAY}.ndjson`, 20);

    // total 140, cap 100: day 10 leaves 100, which is at the cap
    const report = prune({ maxTotalBytes: 100 });

    expect(names()).toEqual(['2026-10-11.ndjson', '2026-10-12.ndjson', `${TODAY}.ndjson`]);
    expect(report.deleted).toEqual([{ file: '2026-10-10.ndjson', bytes: 40, reason: 'total size over 0 MB' }]);
    expect(report.remainingBytes).toBe(100);
  });

  it('never deletes keepDay and warns, naming the history, when it alone is over the cap', () => {
    put('2026-10-10.ndjson', 10);
    put(`${TODAY}.ndjson`, 120);

    const report = prune({ maxTotalBytes: 100 });

    expect(names()).toEqual([`${TODAY}.ndjson`]);
    expect(report.deleted.map(d => d.file)).toEqual(['2026-10-10.ndjson']);
    expect(report.warning).toContain(`History of ${TODAY} alone uses 120 bytes`);
    expect(report.warning).toContain('queue history');
  });

  it('only touches <day>.ndjson: a launcher log, a .log and other files are left alone, even when old', () => {
    put('2020-01-01-launcher.log');
    put('2020-01-01.log');
    put('2020-01-01.ndjson.bak');
    put('notes.txt');
    put('wal.ndjson');
    const before = names();

    const report = prune({ maxTotalBytes: 1 });

    expect(names()).toEqual(before);
    expect(report.deleted).toEqual([]);
  });

  it('the logs kind still deletes the launcher log that the history kind ignores', () => {
    put('2020-01-01-launcher.log');
    pruneLogDir(dir, { now: NOW, keepDay: TODAY });
    expect(names()).toEqual([]);
  });

  it('reports an unlink failure naming the history retention, without throwing', () => {
    mkdirSync(join(dir, '2020-01-01.ndjson'));
    const report = prune();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.file).toBe('2020-01-01.ndjson');
    expect(report.failures[0]!.fix).toContain('delete it by hand');
  });

  it('describes a report with the label, as an info line for the deletions and a warn line for the problems', () => {
    expect(describeRetention('History', { deleted: [], failures: [], remainingBytes: 0 })).toEqual([]);
    const lines = describeRetention('History', {
      deleted: [{ file: 'a.ndjson', bytes: 3, reason: 'older than 90 days' }, { file: 'b.ndjson', bytes: 4, reason: 'older than 90 days' }],
      failures: [{ file: 'c.ndjson', error: 'EBUSY', fix: 'Close it.' }],
      remainingBytes: 9,
      warning: 'Too big.',
    });
    expect(lines).toEqual([
      { level: 'info', message: 'History retention deleted 2 file(s), 7 bytes freed: a.ndjson (older than 90 days), b.ndjson (older than 90 days)' },
      { level: 'warn', message: 'History retention: Too big. | c.ndjson: EBUSY. Close it.' },
    ]);
  });
});
