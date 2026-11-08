import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneLogDir, listLogFiles, describeRetention, describeHistoryLimits, LOG_MAX_AGE_DAYS, LOG_MAX_TOTAL_BYTES, HISTORY_MAX_AGE_DAYS, HISTORY_MAX_TOTAL_BYTES, type PruneOptions, type PruneReport } from './LogRetention.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const TODAY = '2026-10-19';

// The tests pin NOW, so the mtime of a file must not depend on the real clock (a file written "now" has a mtime later than the pinned NOW): set it explicitly
const OLD_MTIME_MS = Date.parse('2020-01-01T00:00:00.000Z');
function writeAged(dir: string, name: string, bytes: number): void {
  writeFileSync(join(dir, name), 'x'.repeat(bytes));
  utimesSync(join(dir, name), new Date(OLD_MTIME_MS), new Date(OLD_MTIME_MS));
}

// An fs error with a code, as the OS reports it
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

// An unlink that fails with EBUSY for the file whose name ends with `busyName` (held open by another program), and works for the others
function busyUnlink(busyName: string): (path: string) => void {
  return path => {
    if (path.endsWith(busyName)) throw errno('EBUSY');
    unlinkSync(path);
  };
}

describe('pruneLogDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, bytes = 10): void => writeAged(dir, name, bytes);
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

  it('keeps exactly 91 calendar days: today and the 90 before (the documented age), and deletes the day before those', () => {
    // 2026-10-19 minus 90 days is 2026-07-21
    put('2026-07-21.ndjson');
    put('2026-07-20.ndjson');
    put(`${TODAY}.ndjson`);
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY });
    expect(names()).toEqual(['2026-07-21.ndjson', `${TODAY}.ndjson`]);
    expect(report.deleted.map(d => d.file)).toEqual(['2026-07-20.ndjson']);
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
    // The first file is held open by another program: its unlink fails (this used a directory named like a log file, which the retention now skips on its own, see the non-regular file tests)
    put('2020-01-01.ndjson');
    put('2020-01-02.ndjson', 3);
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('2026-10-18.ndjson');

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, unlink: busyUnlink('2020-01-01.ndjson') });

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

  const put = (name: string, bytes = 10): void => writeAged(dir, name, bytes);
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
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('2026-10-18.ndjson');
    pruneLogDir(dir, { now: NOW, keepDay: TODAY });
    expect(names()).toEqual(['2026-10-18.ndjson']);
  });

  it('reports an unlink failure naming the history retention, without throwing', () => {
    // Held open by another program: its unlink fails (this used a directory named like a log file, which the retention now skips on its own)
    put('2020-01-01.ndjson');
    put('2026-10-18.ndjson');
    const report = prune({ unlink: busyUnlink('2020-01-01.ndjson') });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.file).toBe('2020-01-01.ndjson');
    expect(report.failures[0]!.fix).toContain('delete it by hand');
  });

  it('words the history limits as the calendar days really kept (today and the 90 days before), not as "at most 90 days"', () => {
    expect(describeHistoryLimits()).toBe('the history keeps the last 91 calendar days (today and the 90 days before) and 200 MB');
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

describe('pruneLogDir clock safety (a forward clock jump or a long idle never deletes more than the normal window)', () => {
  let dir: string;
  // Real file mtimes far in the past: only the name and the clock under test decide
  const OLD_MTIME = new Date('2020-01-01T00:00:00.000Z');

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-clock-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, bytes = 10): void => {
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), OLD_MTIME, OLD_MTIME);
  };
  const names = (): string[] => readdirSync(dir).sort();
  const dayBefore = (from: string, days: number): string => new Date(Date.parse(`${from}T00:00:00.000Z`) - days * 24 * 3600_000).toISOString().slice(0, 10);
  // 40 consecutive daily files ending on `last`
  const putDays = (last: string, count = 40): string[] => {
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `${dayBefore(last, i)}.ndjson`;
      put(name);
      created.push(name);
    }
    return created.sort();
  };

  it.each(['logs', 'history'] as const)('a clock 200 days ahead of the newest %s file deletes nothing and warns loudly', (kind) => {
    const created = putDays(TODAY);
    const jumped = new Date(Date.parse(`${TODAY}T12:00:00.000Z`) + 200 * 24 * 3600_000);

    const report = pruneLogDir(dir, { kind, now: jumped, keepDay: jumped.toISOString().slice(0, 10) });

    expect(names()).toEqual(created);
    expect(report.deleted).toEqual([]);
    expect(report.warning).toContain('200 days');
    expect(report.warning).toContain(TODAY);
    expect(report.warning).toMatch(/clock/i);
    // The anchor is the newest file's day + 2: nothing newer than 90 days before it can go
    expect(report.warning).toContain('counted from 2026-10-21 instead of today');
    expect(report.warning).toContain('Check the system date');
  });

  it('the warning of a clock jump reaches the log lines (describeRetention warn line)', () => {
    putDays(TODAY);
    const jumped = new Date(Date.parse(`${TODAY}T12:00:00.000Z`) + 200 * 24 * 3600_000);
    const report = pruneLogDir(dir, { kind: 'history', now: jumped, keepDay: jumped.toISOString().slice(0, 10) });
    const lines = describeRetention('History', report);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.message).toContain('200 days');
  });

  it('a normal day roll-over still prunes the 91st day and does not warn', () => {
    // 2026-10-20 minus 90 days is 2026-07-22: 07-22 stays, 07-21 goes
    put('2026-07-21.ndjson', 7);
    put('2026-07-22.ndjson');
    put(`${TODAY}.ndjson`);

    const report = pruneLogDir(dir, { kind: 'history', now: new Date('2026-10-20T00:00:01.000Z'), keepDay: '2026-10-20' });

    expect(names()).toEqual(['2026-07-22.ndjson', `${TODAY}.ndjson`]);
    expect(report.deleted).toEqual([{ file: '2026-07-21.ndjson', bytes: 7, reason: 'older than 90 days' }]);
    expect(report.warning).toBeUndefined();
  });

  it('an idle daemon (newest file 10 days old) prunes only what is older than 90 days relative to the newest file, and warns', () => {
    // Newest 2026-10-09; now 2026-10-19. Anchor = newest + 2 days = 2026-10-11, so 2026-07-13 (90 days before) is kept and 2026-07-12 goes.
    put('2026-07-12.ndjson', 7);
    put('2026-07-13.ndjson');
    put('2026-10-09.ndjson');

    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY });

    expect(names()).toEqual(['2026-07-13.ndjson', '2026-10-09.ndjson']);
    expect(report.deleted).toEqual([{ file: '2026-07-12.ndjson', bytes: 7, reason: 'older than 90 days' }]);
    expect(report.warning).toContain('10 days');
  });

  it('a gap of exactly 2 days between the newest file and now is normal: no warning', () => {
    put('2026-10-17.ndjson');
    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY });
    expect(report.warning).toBeUndefined();
  });

  it('refuses to delete more than half of the files, and more than 10, in one run, and says how to force it', () => {
    // 30 old files (all over age relative to the newest) + 5 recent: 30 of 35 would go
    for (let i = 0; i < 30; i++) put(`${dayBefore('2026-03-01', i)}.ndjson`);
    putDays(TODAY, 5);

    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY });

    expect(names()).toHaveLength(35);
    expect(report.deleted).toEqual([]);
    expect(report.warning).toContain('30 of 35');
    expect(report.warning).toMatch(/by hand|dashboard/);
  });

  it('the half-of-the-files cap does not apply to a small directory or to a minority of files', () => {
    // 8 old of 9: more than half but not more than 10 files
    for (let i = 0; i < 8; i++) put(`${dayBefore('2026-03-01', i)}.ndjson`);
    put(`${TODAY}.ndjson`);
    expect(pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY }).deleted).toHaveLength(8);

    // 11 old of 40 (28 recent + 1 today... ): more than 10 files but a minority
    for (let i = 0; i < 11; i++) put(`${dayBefore('2026-03-01', i)}.ndjson`);
    putDays(TODAY, 29);
    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY });
    expect(report.deleted).toHaveLength(11);
    expect(report.warning).toBeUndefined();
  });

  it('the size pass is unaffected by the clock anchor and the cap', () => {
    put('2026-10-10.ndjson', 40);
    put('2026-10-11.ndjson', 40);
    put(`${TODAY}.ndjson`, 40);
    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY, maxTotalBytes: 100 });
    expect(report.deleted).toEqual([{ file: '2026-10-10.ndjson', bytes: 40, reason: 'total size over 0 MB' }]);
  });
});

describe('pruneLogDir with entries that are not regular files', () => {
  let dir: string;
  const OLD_MTIME = new Date('2020-01-01T00:00:00.000Z');

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-nonfile-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, bytes = 10): void => {
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), OLD_MTIME, OLD_MTIME);
  };

  it.each(['logs', 'history'] as const)('a directory named like a day file is skipped with its own report line, never unlinked, and does not count in the %s sizes or file counts', (kind) => {
    mkdirSync(join(dir, '2020-01-01.ndjson'));
    put('2020-01-02.ndjson', 3);
    put('2026-10-18.ndjson', 5);
    let unlinked: string[] = [];

    const report = pruneLogDir(dir, {
      kind,
      now: NOW,
      keepDay: TODAY,
      unlink: path => {
        unlinked = [...unlinked, path];
        unlinkSync(path);
      },
    });

    // The directory is never handed to unlink (no EPERM, no misleading "held open" advice) and the real old file is still pruned
    expect(unlinked.some(p => p.endsWith('2020-01-01.ndjson'))).toBe(false);
    expect(existsSync(join(dir, '2020-01-01.ndjson'))).toBe(true);
    expect(report.deleted.map(d => d.file)).toEqual(['2020-01-02.ndjson']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.file).toBe('2020-01-01.ndjson');
    expect(report.failures[0]!.error).toContain('not a regular file');
    expect(report.failures[0]!.fix).toContain('by hand');
    expect(report.failures[0]!.fix).not.toContain('held open');
    // Only the regular files are counted
    expect(report.remainingBytes).toBe(5);
    const lines = describeRetention('Log', report);
    expect(lines.some(l => l.level === 'warn' && l.message.includes('2020-01-01.ndjson') && l.message.includes('not a regular file'))).toBe(true);
  });

  it('the listing reports the directory as a failure and not as a file', () => {
    mkdirSync(join(dir, '2020-01-01.ndjson'));
    put('2026-10-18.ndjson', 5);
    const listing = listLogFiles(dir, { kind: 'history', now: NOW });
    expect(listing.files.map(f => f.name)).toEqual(['2026-10-18.ndjson']);
    expect(listing.failures.map(f => f.file)).toEqual(['2020-01-01.ndjson']);
    expect(listing.totalBytes).toBe(5);
  });

  it('a directory does not make the mass-delete cap think there are more files', () => {
    // 11 old regular files + 11 recent ones: 11 of 22 is exactly half, not more than half, so the age pass runs
    for (let d = 1; d <= 11; d++) put(`2020-01-${String(d).padStart(2, '0')}.ndjson`);
    for (let d = 8; d <= 18; d++) put(`2026-10-${String(d).padStart(2, '0')}.ndjson`);
    mkdirSync(join(dir, '2019-01-01.ndjson'));
    const report = pruneLogDir(dir, { kind: 'history', now: NOW, keepDay: TODAY });
    expect(report.deleted).toHaveLength(11);
  });
});
