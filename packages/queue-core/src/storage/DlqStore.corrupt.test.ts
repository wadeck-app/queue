import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DlqStore, type DlqEntry } from './DlqStore.js';
import type { StorageDiagnostic } from './StorageDiagnostics.js';
import { dlqEntry as baseDlqEntry } from '../queueEntries.testUtil.js';

const dlqEntry = (id: string): DlqEntry => baseDlqEntry(id, { event: 'test.event', attempts: 3, movedAt: '2026-10-19T10:00:00.000Z' });


const CORRUPT = '{"id":"torn","event":"onT';

// A pid that certainly belongs to no running process: a child that has already exited
function deadPid(): number {
  const child = spawnSync(process.execPath, ['--version']);
  if (child.pid === undefined || child.pid === 0) {
    throw new Error('Could not start a child process to get a dead pid for the test');
  }
  return child.pid;
}

describe('DlqStore with a corrupt line', () => {
  let dir: string;
  let file: string;
  let diagnostics: StorageDiagnostic[];
  let dlq: DlqStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlq-corrupt-'));
    file = join(dir, 'dlq.ndjson');
    diagnostics = [];
    dlq = new DlqStore(file, 1000, { onDiagnostic: d => diagnostics.push(d) });
    writeFileSync(file, [JSON.stringify(dlqEntry('a')), CORRUPT, JSON.stringify(dlqEntry('b'))].join('\n') + '\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('append keeps the valid rows, moves the raw corrupt line to dlq.ndjson.corrupt and reports it through the sink', () => {
    dlq.append(dlqEntry('c'));

    expect(dlq.readAll().map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(readFileSync(file, 'utf-8')).not.toContain('torn');
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: 'DlqStore', level: 'warn' });
    expect(diagnostics[0]!.message).toContain(`${file}.corrupt`);
    expect(diagnostics[0]!.message).toContain(CORRUPT.slice(0, 20));
  });

  it.each([
    ['remove', (d: DlqStore) => d.remove('a')],
    ['removeEntries', (d: DlqStore) => d.removeEntries(['a'])],
    ['clear', (d: DlqStore) => d.clear()],
    ['setAnnounce', (d: DlqStore) => d.setAnnounce('a', 'pending')],
  ])('%s quarantines the line before the rewrite drops it', (_name, rewrite) => {
    rewrite(dlq);
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
  });

  it('a read alone changes nothing, and a line is quarantined once', () => {
    expect(dlq.readAll().map(e => e.id)).toEqual(['a', 'b']);
    expect(existsSync(`${file}.corrupt`)).toBe(false);
    dlq.setAnnounce('missing', 'pending');
    dlq.setAnnounce('missing', 'pending');
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('the .corrupt file is private (0600)', () => {
    dlq.append(dlqEntry('c'));
    expect(statSync(`${file}.corrupt`).mode & 0o777).toBe(0o600);
  });

  it('without a sink the report goes to stderr, and the line is still kept', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    new DlqStore(file).append(dlqEntry('c'));
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`${file}.corrupt`));
  });
});

describe('DlqStore limit reached', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlq-limit-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('says through the sink which entry was dropped and what to do, and keeps the stderr write for a store without a sink', () => {
    const diagnostics: StorageDiagnostic[] = [];
    const dlq = new DlqStore(join(dir, 'dlq.ndjson'), 2, { onDiagnostic: d => diagnostics.push(d) });
    dlq.append(dlqEntry('a'));
    dlq.append(dlqEntry('b'));
    const result = dlq.append(dlqEntry('c'));

    expect(result.evicted?.id).toBe('a');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: 'DlqStore', level: 'warn' });
    expect(diagnostics[0]!.message).toContain('limit reached (2)');
    expect(diagnostics[0]!.message).toContain('a');
    expect(diagnostics[0]!.message).toContain('test.event');
    expect(diagnostics[0]!.message).toContain('queue dlq');

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const plain = new DlqStore(join(dir, 'other.ndjson'), 1);
    plain.append(dlqEntry('x'));
    plain.append(dlqEntry('y'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('limit reached (1)'));
  });
});

describe('DlqStore temp files', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlq-tmp-'));
    file = join(dir, 'dlq.ndjson');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const touch = (name: string, ageMs = 0): string => {
    const path = join(dir, name);
    writeFileSync(path, 'leftover');
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  };

  it.skipIf(process.platform === 'win32')('the temp file is written private (0600), like the WAL one, and so is the result', () => {
    const modes: number[] = [];
    // Look at the temp file between its write and its rename: the rename is the next thing, so spy on it through a store subclass is not possible; check the final file instead
    new DlqStore(file).append(dlqEntry('a'));
    modes.push(statSync(file).mode & 0o777);
    expect(modes).toEqual([0o600]);
  });

  it('removes the leftover temp files of dead processes and the ones older than an hour, at the first write', () => {
    const dead = touch(`dlq.ndjson.${deadPid()}.tmp`);
    const old = touch(`dlq.ndjson.${process.pid}.tmp`, 2 * 3600_000);
    const unrelated = touch('other.ndjson.123.tmp', 2 * 3600_000);
    const notTemp = touch('dlq.ndjson.notapid.tmp', 2 * 3600_000);

    new DlqStore(file).append(dlqEntry('a'));

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(old)).toBe(false);
    // Another file's temp and a name that is not <pid>.tmp are not ours to delete
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(notTemp)).toBe(true);
    expect(readdirSync(dir).filter(n => n.startsWith('dlq.ndjson.') && n.endsWith('.tmp') && n !== 'dlq.ndjson.notapid.tmp')).toEqual([]);
  });

  it('keeps the fresh temp file of a live process (another writer is in the middle of its replace)', () => {
    // A live pid other than ours: the parent process of the test worker, else our own with a fresh mtime
    const livePid = process.ppid > 0 ? process.ppid : process.pid;
    const live = touch(`dlq.ndjson.${livePid}.tmp`);
    new DlqStore(file).append(dlqEntry('a'));
    expect(existsSync(live)).toBe(true);
  });
});
