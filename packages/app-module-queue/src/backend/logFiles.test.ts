import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { QueueLogWriter } from '@wadeck-app/queue-core';
import { clearLastPrune, deleteLogFileEntry, formatBytes, getLogFiles, parseKind, pruneLogFiles } from './logFiles.js';
import { InvalidQueryError, LogFileInUseError, LogFileNotFoundError } from './errors.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const TODAY = '2026-10-19';
const LONG_AGO_MS = 30 * 24 * 3600 * 1000;

let configDir: string;

function fakeLogger(): QueueLogWriter & { diagnostics: Array<{ source: string; message: string; level?: string }> } {
  const diagnostics: Array<{ source: string; message: string; level?: string }> = [];
  return { diagnostics, logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: entry => void diagnostics.push(entry) };
}

// A file whose mtime is `ageMs` before NOW
function put(kind: 'logs' | 'history', name: string, bytes = 10, ageMs = LONG_AGO_MS): void {
  mkdirSync(join(configDir, kind), { recursive: true });
  const path = join(configDir, kind, name);
  writeFileSync(path, 'x'.repeat(bytes));
  const mtime = new Date(NOW.getTime() - ageMs);
  utimesSync(path, mtime, mtime);
}

const names = (kind: 'logs' | 'history'): string[] => readdirSync(join(configDir, kind)).sort();

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-logfiles-'));
  clearLastPrune();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [64 * 1024 * 1024, '64 MB'],
    [100 * 1024 * 1024, '100 MB'],
    [3 * 1024 * 1024 * 1024, '3 GB'],
  ])('%d bytes is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('parseKind', () => {
  it('accepts logs and history, rejects anything else with the accepted values and a truncated echo', () => {
    expect(parseKind('logs')).toBe('logs');
    expect(parseKind('history')).toBe('history');
    expect(() => parseKind('wal')).toThrow(new InvalidQueryError('kind must be one of logs, history, got: "wal"'));
    expect(() => parseKind(undefined)).toThrow(InvalidQueryError);
    expect(() => parseKind('x'.repeat(5000))).toThrow(/^.{1,120}$/s);
  });
});

describe('getLogFiles', () => {
  it('answers empty sections (exists false) and absent queue files when nothing exists yet', () => {
    const response = getLogFiles(configDir, NOW);
    expect(response.today).toBe(TODAY);
    expect(response.sections.map(s => [s.kind, s.label, s.exists, s.files.length])).toEqual([
      ['logs', 'Logs', false, 0],
      ['history', 'History', false, 0],
    ]);
    expect(response.sections[0]).toMatchObject({ totalBytes: 0, usagePercent: 0, prunableCount: 0, prunableText: 'nothing', maxTotalText: '100 MB', usageText: '0 B of 100 MB (0%)' });
    expect(response.sections[1]).toMatchObject({ maxTotalText: '200 MB', maxAgeDays: 90 });
    expect(response.queueFiles).toEqual([
      { name: 'wal.ndjson', exists: false, bytes: 0, sizeText: 'absent', modifiedMs: null, modifiedAt: null },
      { name: 'dlq.ndjson', exists: false, bytes: 0, sizeText: 'absent', modifiedMs: null, modifiedAt: null },
    ]);
    expect(response.lastPrune).toBeUndefined();
    expect(response.sections.every(s => s.warning === undefined)).toBe(true);
  });

  it('lists each file with unique ids, size, zone, status and whether it can be deleted; wal and dlq are info only', () => {
    put('logs', '2026-08-01.ndjson', 2048);
    put('logs', '2026-10-17.ndjson', 100);
    put('logs', '2026-10-17-launcher.log', 50);
    put('logs', `${TODAY}.ndjson`, 10);
    put('history', '2026-10-10.ndjson', 7);
    writeFileSync(join(configDir, 'wal.ndjson'), 'abcd');

    const response = getLogFiles(configDir, NOW);
    const logs = response.sections[0]!;

    expect(logs.files.map(f => [f.id, f.dayZone, f.status, f.canDelete, f.sizeText])).toEqual([
      [`logs:${TODAY}:daemon`, 'UTC', 'protected', false, '10 B'],
      ['logs:2026-10-17:daemon', 'UTC', 'kept', true, '100 B'],
      ['logs:2026-10-17:launcher', 'local', 'kept', true, '50 B'],
      ['logs:2026-08-01:daemon', 'UTC', 'kept', true, '2 KB'],
    ]);
    expect(logs.files[0]!.statusText).toBe('protected (today (UTC))');
    expect(logs.files[1]).toMatchObject({ dayText: '2026-10-17 UTC', reasonText: 'within retention', modifiedAt: new Date(logs.files[1]!.modifiedMs).toISOString() });
    expect(logs.files[2]!.dayText).toBe('2026-10-17 local');
    expect(logs.files[0]!.reasonText).toBe('today (UTC)');
    expect(logs.dirText).toBe(`Directory: \`${logs.dir}\``);
    // The page binds these two by name: the DSL has no index access
    expect(response.logs).toBe(response.sections[0]);
    expect(response.history).toBe(response.sections[1]);
    expect(response.note).toContain(TODAY);
    // The note states the whole policy: the exact age (91 calendar days: today and the 90 before) and every protection, launcher and future-mtime rules included
    expect(response.note).toContain('last 91 calendar days (today and the 90 before)');
    expect(response.note).toContain('tomorrow');
    expect(response.note).toContain('24 hours');
    expect(response.note).toContain('last minute');
    expect(response.note).toContain('future');
    expect(response.note).toContain('modification time');
    expect(logs.totalBytes).toBe(2208);
    expect(response.sections[1]!.files.map(f => f.id)).toEqual(['history:2026-10-10:daemon']);
    const ids = response.sections.flatMap(s => s.files.map(f => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(response.queueFiles[0]).toMatchObject({ name: 'wal.ndjson', exists: true, bytes: 4, sizeText: '4 B' });
  });

  it('marks what the retention would delete, with the totals and the reason', () => {
    put('logs', '2026-01-01.ndjson', 30);
    put('logs', '2026-01-01-launcher.log', 20);
    put('logs', '2026-10-17.ndjson', 5);

    const logs = getLogFiles(configDir, NOW).sections[0]!;

    expect(logs.files.filter(f => f.status === 'prune').map(f => [f.name, f.statusText])).toEqual([
      ['2026-01-01.ndjson', 'to prune (older than 90 days)'],
      ['2026-01-01-launcher.log', 'to prune (older than 90 days)'],
    ]);
    expect(logs).toMatchObject({ prunableCount: 2, prunableBytes: 50, prunableText: '2 files, 50 B' });
  });

  it('a section within its caps has no warning', () => {
    put('logs', '2026-10-17.ndjson', 5);
    expect(getLogFiles(configDir, NOW).sections[0]!.warning).toBeUndefined();
  });

  it('throws a message naming the directory and the fix when an existing directory cannot be read', () => {
    // A regular file where the logs directory should be
    writeFileSync(join(configDir, 'logs'), 'x');
    expect(() => getLogFiles(configDir, NOW)).toThrow(/Cannot read the logs directory .*Check that it is a readable directory/);
  });
});

describe('pruneLogFiles', () => {
  it('deletes only what the policy deletes, reports counts and freed size, and writes one audit line', () => {
    put('logs', '2026-01-01.ndjson', 2048);
    put('logs', '2026-01-01-launcher.log', 1024);
    put('logs', '2026-10-17.ndjson', 5);
    put('logs', `${TODAY}.ndjson`, 5);
    put('history', '2026-01-01.ndjson', 7);
    const logger = fakeLogger();

    const result = pruneLogFiles(configDir, 'logs', NOW, logger);

    expect(names('logs')).toEqual(['2026-10-17.ndjson', `${TODAY}.ndjson`]);
    expect(names('history')).toEqual(['2026-01-01.ndjson']);
    expect(result.deleted.map(d => d.file).sort()).toEqual(['2026-01-01-launcher.log', '2026-01-01.ndjson']);
    expect(result).toMatchObject({ kind: 'logs', freedBytes: 3072, freedText: '3 KB', failures: [], alreadyGone: [], remainingBytes: 10 });
    expect(result.message).toBe('Deleted 2 log files, 3 KB freed.');
    expect(logger.diagnostics).toHaveLength(1);
    expect(logger.diagnostics[0]).toMatchObject({ source: 'LogFilesPage', level: 'info' });
    expect(logger.diagnostics[0]!.message).toContain('Dashboard log retention deleted 2 file(s)');
    expect(getLogFiles(configDir, NOW).lastPrune).toMatchObject({ at: NOW.toISOString(), what: 'Pruned logs by policy', message: result.message });
  });

  it('prunes the history directory on its own', () => {
    put('logs', '2026-01-01.ndjson');
    put('history', '2026-01-01.ndjson', 7);
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('history', '2026-10-18.ndjson', 0);
    const result = pruneLogFiles(configDir, 'history', NOW, fakeLogger());
    expect(names('logs')).toEqual(['2026-01-01.ndjson']);
    expect(names('history')).toEqual(['2026-10-18.ndjson']);
    expect(result.message).toBe('Deleted 1 history file, 7 B freed.');
  });

  it('says so when there is nothing to prune, and still writes the audit line', () => {
    put('logs', '2026-10-17.ndjson');
    const logger = fakeLogger();
    const result = pruneLogFiles(configDir, 'logs', NOW, logger);
    expect(result.message).toBe('Nothing to prune in the log files.');
    expect(result.deleted).toEqual([]);
    expect(logger.diagnostics[0]!.message).toBe('Dashboard log prune by policy: nothing to delete');
  });

  it('a missing directory is nothing to prune, not an error', () => {
    expect(pruneLogFiles(configDir, 'history', NOW, fakeLogger()).message).toBe('Nothing to prune in the history files.');
  });

  it('never deletes a future-dated launcher file, even when the cap is exceeded', () => {
    put('logs', '2026-10-22-launcher.log', 50);
    const result = pruneLogFiles(configDir, 'logs', NOW, fakeLogger());
    expect(names('logs')).toEqual(['2026-10-22-launcher.log']);
    expect(result.deleted).toEqual([]);
  });

  it('rejects a bad kind (400) before touching anything', () => {
    put('logs', '2026-01-01.ndjson');
    expect(() => pruneLogFiles(configDir, 'wal', NOW, fakeLogger())).toThrow(InvalidQueryError);
    expect(names('logs')).toEqual(['2026-01-01.ndjson']);
  });

  // Was 'reports a file that cannot be deleted ...' with the dashboard fix of a failed unlink: a directory named like a log file is no longer handed to unlink
  // (that pinned the misleading "held open" advice), it is reported as not a regular file with its own fix
  it('reports a directory named like a log file in the 200 body, with a fix that says to remove it by hand, and keeps going', () => {
    mkdirSync(join(configDir, 'logs', '2020-01-01.ndjson'), { recursive: true });
    put('logs', '2020-01-02.ndjson', 3);
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('logs', '2026-10-18.ndjson', 0);
    const logger = fakeLogger();

    const result = pruneLogFiles(configDir, 'logs', NOW, logger);

    expect(result.deleted.map(d => d.file)).toEqual(['2020-01-02.ndjson']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain('not a regular file');
    expect(result.failures[0]!.fix).toContain('by hand');
    expect(result.message).toContain('1 file could not be deleted: 2020-01-01.ndjson');
    expect(logger.diagnostics[0]!.level).toBe('warn');
  });

  it('throws the readable-directory message when the directory exists but cannot be read', () => {
    writeFileSync(join(configDir, 'logs'), 'x');
    expect(() => pruneLogFiles(configDir, 'logs', NOW, fakeLogger())).toThrow(/Cannot read the logs directory/);
  });

  it('still succeeds when the audit line cannot be written, and says so in the message', () => {
    put('logs', '2026-01-01.ndjson');
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('logs', '2026-10-18.ndjson', 0);
    const logger: QueueLogWriter = {
      logDispatch: vi.fn(),
      logFilterMiss: vi.fn(),
      logDiagnostic: () => {
        throw new Error('EACCES: logs');
      },
    };
    const result = pruneLogFiles(configDir, 'logs', NOW, logger);
    expect(names('logs')).toEqual(['2026-10-18.ndjson']);
    expect(result.message).toContain('The audit line could not be written to the day log: EACCES: logs');
  });

  it('writes the audit line to the day log with the default logger', () => {
    // The real clock: the default logger stamps the day file with it
    const now = new Date();
    put('logs', '2020-01-01.ndjson');
    // Yesterday's file: the age pass is counted from the newest file (at most 2 days after it), so it needs a recent one to see the real clock
    put('logs', `${new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10)}.ndjson`, 0);
    pruneLogFiles(configDir, 'logs', now);
    const dayFile = join(configDir, 'logs', `${now.toISOString().slice(0, 10)}.ndjson`);
    expect(existsSync(dayFile)).toBe(true);
    const lines = readFileSync(dayFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as { source?: string; message?: string });
    expect(lines.some(l => l.source === 'LogFilesPage' && l.message?.includes('2020-01-01.ndjson'))).toBe(true);
  });
});

describe('deleteLogFileEntry', () => {
  it('deletes one file, answers deleted true with the name and size in the message, audits, and remembers it', () => {
    put('logs', '2026-10-10.ndjson', 2048);
    put('logs', '2026-10-11.ndjson', 5);
    const logger = fakeLogger();

    const result = deleteLogFileEntry(configDir, 'logs', '2026-10-10', 'daemon', NOW, logger);

    expect(result).toEqual({ kind: 'logs', deleted: true, file: '2026-10-10.ndjson', bytes: 2048, message: 'Deleted logs file 2026-10-10.ndjson (2 KB).' });
    expect(names('logs')).toEqual(['2026-10-11.ndjson']);
    expect(logger.diagnostics).toEqual([{ source: 'LogFilesPage', level: 'info', message: 'Dashboard deleted the logs file 2026-10-10.ndjson (2048 bytes)' }]);
    expect(getLogFiles(configDir, NOW).lastPrune?.what).toBe('Deleted logs file 2026-10-10.ndjson');
  });

  it('deletes a history day and a launcher file', () => {
    put('history', '2026-10-10.ndjson');
    put('logs', '2026-10-10-launcher.log');
    expect(deleteLogFileEntry(configDir, 'history', '2026-10-10', 'daemon', NOW, fakeLogger()).deleted).toBe(true);
    expect(deleteLogFileEntry(configDir, 'logs', '2026-10-10', 'launcher', NOW, fakeLogger()).deleted).toBe(true);
  });

  it('a file already gone is a 200 with deleted false and the message "already gone", no audit line', () => {
    const logger = fakeLogger();
    const result = deleteLogFileEntry(configDir, 'logs', '2026-10-10', 'daemon', NOW, logger);
    expect(result).toEqual({ kind: 'logs', deleted: false, file: '2026-10-10.ndjson', bytes: 0, message: '2026-10-10.ndjson was already gone.' });
    expect(logger.diagnostics).toEqual([]);
  });

  it('history with the launcher variant is a not-found (404)', () => {
    expect(() => deleteLogFileEntry(configDir, 'history', '2026-10-10', 'launcher', NOW, fakeLogger())).toThrow(LogFileNotFoundError);
  });

  it('today, the future and a recently modified file are refused (409) and stay', () => {
    put('logs', `${TODAY}.ndjson`);
    put('logs', '2026-10-25.ndjson');
    put('logs', '2026-10-10.ndjson', 10, 5000);
    for (const day of [TODAY, '2026-10-25', '2026-10-10']) {
      expect(() => deleteLogFileEntry(configDir, 'logs', day, 'daemon', NOW, fakeLogger())).toThrow(LogFileInUseError);
    }
    expect(names('logs')).toHaveLength(3);
  });

  it.each(['../x', '..%2Fx', '2026-02-30', '2026-13-01', '', '2026-10-10\0'])('rejects the day %j as a malformed value (400)', day => {
    put('logs', '2026-10-10.ndjson');
    expect(() => deleteLogFileEntry(configDir, 'logs', day, 'daemon', NOW, fakeLogger())).toThrow(InvalidQueryError);
    expect(names('logs')).toEqual(['2026-10-10.ndjson']);
  });

  it('rejects an unknown kind and variant (400)', () => {
    expect(() => deleteLogFileEntry(configDir, 'wal', '2026-10-10', 'daemon', NOW, fakeLogger())).toThrow('kind must be one of logs, history, got: "wal"');
    expect(() => deleteLogFileEntry(configDir, 'logs', '2026-10-10', 'both', NOW, fakeLogger())).toThrow('variant must be one of daemon, launcher, got: "both"');
  });

  it('throws an error carrying the cause and the fix when the file cannot be deleted', () => {
    mkdirSync(join(configDir, 'logs', '2020-01-01.ndjson'), { recursive: true });
    expect(() => deleteLogFileEntry(configDir, 'logs', '2020-01-01', 'daemon', NOW, fakeLogger())).toThrow(/2020-01-01\.ndjson could not be deleted: .*not a regular file.*Remove or rename/);
  });
});
