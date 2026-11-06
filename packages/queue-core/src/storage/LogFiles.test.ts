import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneLogDir, describeRetention, listLogFiles, deleteLogFile, statQueueFiles, parseLogDay, protectionReason, InvalidLogFileError } from './LogRetention.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const TODAY = '2026-10-19';
const LONG_AGO_MS = 30 * 24 * 3600 * 1000;

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

// Runs `fn` with process.env.TZ set, then restores it
function withTz<T>(tz: string, fn: () => T): T {
  const original = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    // Fail loudly if the platform ignores the switch: the local-day tests would prove nothing
    const probe = new Date('2026-10-19T05:00:00.000Z');
    if (tz === 'Pacific/Pago_Pago' && probe.getDate() !== 18) {
      throw new Error(`process.env.TZ=${tz} is not honoured by this Node on this platform (local day of ${probe.toISOString()} is ${probe.getDate()}, expected 18)`);
    }
    return fn();
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
}

describe('parseLogDay', () => {
  it('returns the UTC midnight of a real day', () => {
    expect(parseLogDay('2026-10-19')).toBe(Date.parse('2026-10-19T00:00:00.000Z'));
    expect(parseLogDay('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00.000Z'));
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '0000-01-01', '1969-12-31', '2026-1-01', '', '2026-10-19T00:00', ' 2026-10-19', '../2026-10-19'])(
    'rejects %j',
    day => {
      expect(parseLogDay(day)).toBeUndefined();
    },
  );
});

describe('retention protection and shared policy', () => {
  let dir: string;
  let dir2: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-protect-${crypto.randomUUID()}`);
    dir2 = join(tmpdir(), `queue-retention-protect-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(dir2, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  // Writes a file whose mtime is `ageMs` before NOW (default: long ago, so no mtime guard applies)
  const put = (target: string, name: string, bytes = 10, ageMs = LONG_AGO_MS): void => {
    writeFileSync(join(target, name), 'x'.repeat(bytes));
    const mtime = new Date(NOW.getTime() - ageMs);
    utimesSync(join(target, name), mtime, mtime);
  };
  const names = (target = dir): string[] => readdirSync(target).sort();

  it('dry run deletes nothing and reports the same files and reasons as the real prune on an identical tree (age and size)', () => {
    for (const target of [dir, dir2]) {
      put(target, '2026-07-20.ndjson', 7);
      put(target, '2026-07-20-launcher.log', 5);
      put(target, '2026-10-10.ndjson', 40);
      put(target, '2026-10-11.ndjson', 40);
      put(target, '2026-10-12.ndjson', 40);
      put(target, `${TODAY}.ndjson`, 20);
    }
    const before = names();

    const dry = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100, dryRun: true });
    expect(names()).toEqual(before);

    const real = pruneLogDir(dir2, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });
    expect(dry.deleted.length).toBeGreaterThan(0);
    expect(dry.deleted).toEqual(real.deleted);
    expect(dry.remainingBytes).toBe(real.remainingBytes);
    expect(dry.warning).toBe(real.warning);
    expect(names(dir2)).not.toEqual(before);
  });

  it('listLogFiles gives the same prune verdicts as the real prune', () => {
    for (const target of [dir, dir2]) {
      put(target, '2026-07-20.ndjson', 7);
      put(target, '2026-10-10.ndjson', 40);
      put(target, '2026-10-10-launcher.log', 10);
      put(target, '2026-10-12.ndjson', 40);
      put(target, `${TODAY}.ndjson`, 20);
    }
    const listing = listLogFiles(dir, { kind: 'logs', now: NOW, maxTotalBytes: 100 });
    const real = pruneLogDir(dir2, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });

    const planned = listing.files.filter(f => f.pruneReason !== undefined).map(f => ({ file: f.name, bytes: f.bytes, reason: f.pruneReason }));
    expect([...planned].sort((a, b) => a.file.localeCompare(b.file))).toEqual([...real.deleted].sort((a, b) => a.file.localeCompare(b.file)));
    expect(listing.prunableCount).toBe(real.deleted.length);
    expect(listing.prunableBytes).toBe(real.deleted.reduce((sum, d) => sum + d.bytes, 0));
    expect(listing.totalBytes).toBe(117);
  });

  it('never deletes a future-dated launcher or daemon file, not even in the size pass', () => {
    put(dir, '2026-10-10.ndjson', 30);
    put(dir, '2026-10-21-launcher.log', 80);
    put(dir, '2026-10-22.ndjson', 80);
    put(dir, `${TODAY}.ndjson`, 10);

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100 });

    expect(names()).toEqual([`${TODAY}.ndjson`, '2026-10-21-launcher.log', '2026-10-22.ndjson']);
    expect(report.deleted.map(d => d.file)).toEqual(['2026-10-10.ndjson']);
    expect(report.warning).toContain('protected');
  });

  it('never deletes a very old future-dated file by age either (a day later than UTC today is protected whatever its mtime)', () => {
    put(dir, '2999-01-01-launcher.log');
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxAgeDays: 0 });
    expect(names()).toEqual(['2999-01-01-launcher.log']);
    expect(report.deleted).toEqual([]);
  });

  it('protects the host-local today of a launcher file (west of UTC, where local today is a UTC day behind)', () => {
    withTz('Pacific/Pago_Pago', () => {
      // 05:00 UTC is 18:00 on the 18th in Pago Pago: the launcher is writing 2026-10-18-launcher.log, the daemon 2026-10-19.ndjson
      const now = new Date('2026-10-19T05:00:00.000Z');
      put(dir, '2026-10-18-launcher.log', 50);
      put(dir, '2026-10-18.ndjson', 50);
      put(dir, '2026-10-17-launcher.log', 50);

      const report = pruneLogDir(dir, { now, keepDay: '2026-10-19', maxTotalBytes: 10 });

      expect(names()).toEqual(['2026-10-18-launcher.log']);
      expect(report.deleted.map(d => d.file).sort()).toEqual(['2026-10-17-launcher.log', '2026-10-18.ndjson']);
      const listing = listLogFiles(dir, { kind: 'logs', now });
      expect(listing.files[0]).toMatchObject({ name: '2026-10-18-launcher.log', protected: true, protectedReason: 'today (local)' });
    });
  });

  it('protects the local tomorrow of a launcher file east of UTC, reported as future', () => {
    withTz('Pacific/Kiritimati', () => {
      // 23:30 UTC on the 19th is the 20th in Kiritimati (+14): local tomorrow is the 21st, UTC tomorrow the 20th
      const now = new Date('2026-10-19T23:30:00.000Z');
      expect(protectionReason({ day: '2026-10-21', variant: 'launcher', mtimeMs: 0 }, now)).toBe('future');
      expect(protectionReason({ day: '2026-10-20', variant: 'launcher', mtimeMs: 0 }, now)).toBe('future');
      expect(protectionReason({ day: '2026-10-19', variant: 'launcher', mtimeMs: 0 }, now)).toBe('today (UTC)');
    });
  });

  it('a launcher file of yesterday is not protected by the day rules (UTC zone)', () => {
    withTz('UTC', () => {
      expect(protectionReason({ day: '2026-10-18', variant: 'launcher', mtimeMs: 0 }, NOW)).toBeUndefined();
      expect(protectionReason({ day: '2026-10-19', variant: 'daemon', mtimeMs: 0 }, NOW)).toBe('today (UTC)');
      expect(protectionReason({ day: '2026-10-20', variant: 'daemon', mtimeMs: 0 }, NOW)).toBe('future');
    });
  });

  it('mtime guards: a minute for a daemon file, 24 hours for a launcher file, whatever the name says', () => {
    put(dir, '2026-01-01.ndjson', 10, 30 * 1000);
    put(dir, '2026-01-02.ndjson', 10, 5 * 60 * 1000);
    put(dir, '2026-01-01-launcher.log', 10, 3600 * 1000);
    put(dir, '2026-01-02-launcher.log', 10, 25 * 3600 * 1000);

    const listing = listLogFiles(dir, { kind: 'logs', now: NOW });
    expect(listing.files.filter(f => f.protected).map(f => [f.name, f.protectedReason])).toEqual([
      ['2026-01-01.ndjson', 'recently modified'],
      ['2026-01-01-launcher.log', 'recently modified'],
    ]);

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY });

    expect(names()).toEqual(['2026-01-01-launcher.log', '2026-01-01.ndjson']);
    expect(report.deleted.map(d => d.file).sort()).toEqual(['2026-01-02-launcher.log', '2026-01-02.ndjson']);
  });

  it('an ENOENT on unlink (deleted between the read and the deletion) is a success: no failure, no warning, counted as gone', () => {
    put(dir, '2020-01-01.ndjson', 10);
    put(dir, '2020-01-02.ndjson', 10);
    // The dashboard (or the daemon at midnight) deleted the first file just before us
    const unlink = (path: string): void => {
      unlinkSync(path);
      if (path.endsWith('2020-01-01.ndjson')) throw errno('ENOENT');
    };

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, unlink });

    expect(report.failures).toEqual([]);
    expect(report.warning).toBeUndefined();
    expect(report.alreadyGone).toEqual(['2020-01-01.ndjson']);
    expect(report.deleted.map(d => d.file)).toEqual(['2020-01-02.ndjson']);
    expect(describeRetention('Log', report).every(l => l.level === 'info')).toBe(true);
  });

  it('a file that vanishes before its stat is skipped silently', () => {
    put(dir, '2020-01-01.ndjson', 10);
    const lstat = (): never => {
      throw errno('ENOENT');
    };
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, lstat });
    expect(report.failures).toEqual([]);
    expect(report.deleted).toEqual([]);
  });

  it('a failed age deletion keeps the file, the size pass goes on, and the warning says some files could not be deleted', () => {
    put(dir, '2020-01-01.ndjson', 120);
    put(dir, '2026-10-10.ndjson', 60);
    put(dir, `${TODAY}.ndjson`, 5);
    const unlink = (path: string): void => {
      if (path.endsWith('2020-01-01.ndjson')) throw errno('EBUSY');
      unlinkSync(path);
    };

    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 100, unlink });

    expect(names()).toEqual(['2020-01-01.ndjson', `${TODAY}.ndjson`]);
    expect(report.failures.map(f => f.file)).toEqual(['2020-01-01.ndjson']);
    expect(report.deleted.map(d => [d.file, d.reason])).toEqual([['2026-10-10.ndjson', 'total size over 0 MB']]);
    expect(report.warning).toContain('could not be deleted');
  });

  it('the failure fix is daemon-oriented by default and dashboard-oriented (launcher held open) on request', () => {
    put(dir, '2020-01-01-launcher.log', 10);
    const unlink = (): never => {
      throw errno('EBUSY');
    };

    const daemon = pruneLogDir(dir, { now: NOW, keepDay: TODAY, unlink });
    const dashboard = pruneLogDir(dir, { now: NOW, keepDay: TODAY, unlink, audience: 'dashboard' });

    expect(daemon.failures[0]!.fix).toContain('the next new day retries');
    expect(dashboard.failures[0]!.fix).toContain('held open');
    expect(dashboard.failures[0]!.fix).toContain('queue stop');
  });

  it('no longer treats <day>.log or <day>-launcher.ndjson as log files', () => {
    put(dir, '2020-01-01.log');
    put(dir, '2020-01-01-launcher.ndjson');
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY });
    expect(report.deleted).toEqual([]);
    expect(listLogFiles(dir, { kind: 'logs', now: NOW }).files).toEqual([]);
  });

  it('a name with an impossible day is not a log file', () => {
    put(dir, '2026-02-30.ndjson');
    put(dir, '2026-13-01.ndjson');
    const report = pruneLogDir(dir, { now: NOW, keepDay: TODAY, maxTotalBytes: 1 });
    expect(report.deleted).toEqual([]);
    expect(names()).toHaveLength(2);
  });
});

describe('listLogFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-list-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing directory is an empty listing with exists false, not an error', () => {
    const listing = listLogFiles(join(dir, 'nope'), { kind: 'history', now: NOW });
    expect(listing).toMatchObject({ kind: 'history', exists: false, files: [], totalBytes: 0, maxAgeDays: 90, maxTotalBytes: 200 * 1024 * 1024, prunableCount: 0 });
  });

  it('an existing directory that cannot be read throws a message naming it and the fix', () => {
    // A regular file where the directory should be: readdir fails with ENOTDIR on every platform
    const notADir = join(dir, 'file.txt');
    writeFileSync(notADir, 'x');
    expect(() => listLogFiles(notADir, { kind: 'logs', now: NOW })).toThrow(/Cannot read the logs directory .*file\.txt.*Check that it is a readable directory/);
  });

  it('lists only matching files with name, kind, variant, day, bytes and mtime, newest day first, and the totals', () => {
    writeFileSync(join(dir, '2026-10-17.ndjson'), 'abc');
    writeFileSync(join(dir, '2026-10-17-launcher.log'), 'abcde');
    writeFileSync(join(dir, '2026-10-18.ndjson'), 'a');
    writeFileSync(join(dir, 'wal.ndjson'), 'zzzzzzzz');
    writeFileSync(join(dir, 'notes.txt'), 'zzzzzzzz');

    const listing = listLogFiles(dir, { kind: 'logs', now: NOW });

    expect(listing.exists).toBe(true);
    expect(listing.maxAgeDays).toBe(90);
    expect(listing.maxTotalBytes).toBe(100 * 1024 * 1024);
    expect(listing.totalBytes).toBe(9);
    expect(listing.files.map(f => [f.name, f.variant, f.day, f.bytes])).toEqual([
      ['2026-10-18.ndjson', 'daemon', '2026-10-18', 1],
      ['2026-10-17.ndjson', 'daemon', '2026-10-17', 3],
      ['2026-10-17-launcher.log', 'launcher', '2026-10-17', 5],
    ]);
    expect(listing.files.every(f => f.kind === 'logs' && f.mtimeMs > 0)).toBe(true);
  });

  it('the history kind lists only <day>.ndjson', () => {
    writeFileSync(join(dir, '2026-10-17.ndjson'), 'abc');
    writeFileSync(join(dir, '2026-10-17-launcher.log'), 'abcde');
    expect(listLogFiles(dir, { kind: 'history', now: NOW }).files.map(f => f.name)).toEqual(['2026-10-17.ndjson']);
  });

  it('reports the retention warning and the protected reason of today', () => {
    writeFileSync(join(dir, `${TODAY}.ndjson`), 'x'.repeat(30));
    const listing = listLogFiles(dir, { kind: 'logs', now: NOW, maxTotalBytes: 10 });
    expect(listing.files[0]).toMatchObject({ protected: true, protectedReason: 'today (UTC)' });
    expect(listing.files[0]!.pruneReason).toBeUndefined();
    expect(listing.warning).toContain(`Logs of ${TODAY} alone use 30 bytes`);
  });
});

describe('deleteLogFile', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    outside = join(tmpdir(), `queue-retention-outside-${crypto.randomUUID()}`);
    dir = join(outside, 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'keep');
    writeFileSync(join(outside, '2020-01-01.ndjson'), 'keep');
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  const put = (name: string, ageMs = LONG_AGO_MS): void => {
    writeFileSync(join(dir, name), 'hello');
    const mtime = new Date(NOW.getTime() - ageMs);
    utimesSync(join(dir, name), mtime, mtime);
  };
  const del = (kind: string, day: string, variant: string, extra: Partial<Parameters<typeof deleteLogFile>[2]> = {}): ReturnType<typeof deleteLogFile> =>
    deleteLogFile(dir, { kind, day, variant }, { now: NOW, ...extra });

  it('deletes one old file and nothing else, daemon and launcher', () => {
    put('2026-10-10.ndjson');
    put('2026-10-10-launcher.log');
    put('2026-10-11.ndjson');

    expect(del('logs', '2026-10-10', 'daemon')).toEqual({ status: 'deleted', file: '2026-10-10.ndjson', bytes: 5 });
    expect(readdirSync(dir).sort()).toEqual(['2026-10-10-launcher.log', '2026-10-11.ndjson']);
    expect(del('logs', '2026-10-10', 'launcher')).toEqual({ status: 'deleted', file: '2026-10-10-launcher.log', bytes: 5 });
    expect(del('history', '2026-10-11', 'daemon')).toMatchObject({ status: 'deleted' });
    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(join(outside, '2020-01-01.ndjson'), 'utf-8')).toBe('keep');
  });

  it('allows a file still within retention (not only prunable ones)', () => {
    put('2026-10-18.ndjson');
    expect(del('logs', '2026-10-18', 'daemon')).toMatchObject({ status: 'deleted' });
  });

  it('is idempotent: a file already gone is a success, not an error', () => {
    expect(del('logs', '2026-10-10', 'daemon')).toEqual({ status: 'already-gone', file: '2026-10-10.ndjson' });
  });

  it('a file deleted between the check and the unlink is also already gone', () => {
    put('2026-10-10.ndjson');
    const unlink = (path: string): void => {
      unlinkSync(path);
      throw errno('ENOENT');
    };
    expect(del('logs', '2026-10-10', 'daemon', { unlink })).toEqual({ status: 'already-gone', file: '2026-10-10.ndjson' });
  });

  it('refuses today (UTC), the future, and a recently modified file, with the reason, touching nothing', () => {
    put(`${TODAY}.ndjson`);
    put('2026-10-25.ndjson');
    put('2026-10-10.ndjson', 10 * 1000);
    put('2026-10-09-launcher.log', 3600 * 1000);

    expect(del('logs', TODAY, 'daemon')).toMatchObject({ status: 'refused', reason: 'today (UTC)' });
    expect(del('logs', '2026-10-25', 'daemon')).toMatchObject({ status: 'refused', reason: 'future' });
    expect(del('logs', '2026-10-10', 'daemon')).toMatchObject({ status: 'refused', reason: 'recently modified' });
    expect(del('logs', '2026-10-09', 'launcher')).toMatchObject({ status: 'refused', reason: 'recently modified' });
    expect(readdirSync(dir)).toHaveLength(4);
    const refused = del('logs', TODAY, 'daemon');
    expect(refused.status === 'refused' && refused.message).toContain('protected');
  });

  it('refuses the host-local today of a launcher file (injected clock and TZ)', () => {
    withTz('Pacific/Pago_Pago', () => {
      const now = new Date('2026-10-19T05:00:00.000Z');
      put('2026-10-18-launcher.log');
      put('2026-10-18.ndjson');
      expect(deleteLogFile(dir, { kind: 'logs', day: '2026-10-18', variant: 'launcher' }, { now })).toMatchObject({ status: 'refused', reason: 'today (local)' });
      expect(deleteLogFile(dir, { kind: 'logs', day: '2026-10-18', variant: 'daemon' }, { now })).toMatchObject({ status: 'deleted' });
    });
  });

  it('history has no launcher variant', () => {
    expect(del('history', '2026-10-10', 'launcher')).toMatchObject({ status: 'unsupported' });
  });

  it.each([
    '../2020-01-01',
    '..%2F..%2F2020-01-01',
    '2026-10-10/../../x',
    '..\\2020-01-01',
    '2026-10-10\0',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '0000-01-01',
    '',
    'a'.repeat(5000),
  ])('rejects the day %j without touching the disk', day => {
    expect(() => del('logs', day, 'daemon')).toThrow(InvalidLogFileError);
    expect(() => del('logs', day, 'daemon')).toThrow(/day must be a day as YYYY-MM-DD, got: /);
    expect(readFileSync(join(outside, '2020-01-01.ndjson'), 'utf-8')).toBe('keep');
  });

  it('truncates the echo of a rejected value', () => {
    expect(() => del('logs', 'a'.repeat(5000), 'daemon')).toThrow(/^.{1,120}$/s);
  });

  it('rejects an unknown kind and an unknown variant with the accepted values', () => {
    expect(() => del('wal', '2020-01-01', 'daemon')).toThrow('kind must be one of logs, history, got: "wal"');
    expect(() => del('..', '2020-01-01', 'daemon')).toThrow('kind must be one of logs, history, got: ".."');
    expect(() => del('logs', '2020-01-01', 'both')).toThrow('variant must be one of daemon, launcher, got: "both"');
    expect(() => del('logs', '2020-01-01', '../x')).toThrow(InvalidLogFileError);
  });

  it('refuses a directory named like a log file (it is not a regular file)', () => {
    mkdirSync(join(dir, '2020-01-01.ndjson'));
    const result = del('logs', '2020-01-01', 'daemon');
    expect(result).toMatchObject({ status: 'failed', file: '2020-01-01.ndjson' });
    expect(result.status === 'failed' && result.error).toContain('not a regular file');
    expect(existsSync(join(dir, '2020-01-01.ndjson'))).toBe(true);
  });

  it('reports a failing unlink with the dashboard fix for EBUSY and EPERM (held open by the launcher), a generic one otherwise', () => {
    put('2020-01-01-launcher.log');
    for (const code of ['EBUSY', 'EPERM']) {
      const unlink = (): never => {
        throw errno(code);
      };
      const result = del('logs', '2020-01-01', 'launcher', { unlink });
      expect(result).toMatchObject({ status: 'failed', file: '2020-01-01-launcher.log' });
      if (result.status !== 'failed') throw new Error('expected failed');
      expect(result.error).toContain(code);
      expect(result.fix).toContain('held open by a running program');
      expect(result.fix).toContain('queue stop');
    }
    const other = del('logs', '2020-01-01', 'launcher', {
      unlink: () => {
        throw errno('EIO');
      },
    });
    expect(other.status === 'failed' && other.fix).toContain('Close whatever holds');
    expect(existsSync(join(dir, '2020-01-01-launcher.log'))).toBe(true);
  });

  it('reports a stat error other than ENOENT as a failure with a fix', () => {
    const result = del('logs', '2020-01-01', 'daemon', {
      lstat: () => {
        throw errno('EACCES');
      },
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.status === 'failed' && result.fix).toContain('permissions');
  });
});

describe('statQueueFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `queue-retention-queuefiles-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives size and mtime of wal and dlq, and exists false for a missing one', () => {
    writeFileSync(join(dir, 'wal.ndjson'), 'abcd');
    const [wal, dlq] = statQueueFiles(dir);
    expect(wal).toMatchObject({ name: 'wal.ndjson', exists: true, bytes: 4, path: join(dir, 'wal.ndjson') });
    expect(wal!.mtimeMs).toBeGreaterThan(0);
    expect(dlq).toEqual({ name: 'dlq.ndjson', path: join(dir, 'dlq.ndjson'), exists: false, bytes: 0 });
  });

  it('throws an actionable error when a file cannot be read', () => {
    expect(() =>
      statQueueFiles(dir, {
        lstat: () => {
          throw errno('EACCES');
        },
      }),
    ).toThrow(/Cannot read .*wal\.ndjson.*Check its permissions/);
  });
});
