import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneLogDir, LOG_MAX_AGE_DAYS, LOG_MAX_TOTAL_BYTES } from './LogRetention.js';

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
