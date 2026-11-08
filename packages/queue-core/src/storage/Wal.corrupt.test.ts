import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './Wal.js';
import type { StorageDiagnostic } from './StorageDiagnostics.js';

function makeEntry(id: string, overrides: Partial<WalEntry> = {}): WalEntry {
  return { id, timestamp: new Date().toISOString(), event: 'test.event', payload: { x: 1 }, meta: { cwd: '/tmp' }, subscriberId: 'sub-1', status: 'pending', attempts: 0, ...overrides };
}

const CORRUPT = '{"id":"torn","timestamp":"2026-10-19T10:00:00.000Z","event":"onT';

// A corrupt WAL line used to be reported to a stderr nobody sees and then dropped by the next rewrite: now it is kept aside and reported where the user looks
describe('Wal with a corrupt line', () => {
  let dir: string;
  let file: string;
  let diagnostics: StorageDiagnostic[];
  let wal: Wal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-corrupt-'));
    file = join(dir, 'wal.ndjson');
    diagnostics = [];
    wal = new Wal(file, { onDiagnostic: d => diagnostics.push(d) });
    // a, a corrupt line, b
    writeFileSync(file, [JSON.stringify(makeEntry('a')), CORRUPT, JSON.stringify(makeEntry('b'))].join('\n') + '\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('append keeps the valid lines, moves the raw corrupt line to wal.ndjson.corrupt and reports it through the sink', () => {
    wal.append(makeEntry('c'));

    expect(wal.readAll().map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(readFileSync(file, 'utf-8')).not.toContain('torn');
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source: 'Wal', level: 'warn' });
    expect(diagnostics[0]!.message).toContain(`${file}.corrupt`);
    expect(diagnostics[0]!.message).toContain('1 unreadable line');
    expect(diagnostics[0]!.message).toContain(CORRUPT.slice(0, 40));
  });

  it.each([
    ['updateEntry', (w: Wal) => w.updateEntry('a', { attempts: 2 })],
    ['updateEntryIf', (w: Wal) => w.updateEntryIf('a', () => true, { attempts: 2 })],
    ['upsert', (w: Wal) => w.upsert(makeEntry('a'))],
    ['removeWhere', (w: Wal) => w.removeWhere(e => e.id === 'a')],
  ])('%s quarantines the line before the rewrite drops it', (_name, rewrite) => {
    rewrite(wal);
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
    expect(wal.readAll().map(e => e.id)).toContain('b');
  });

  it('a read alone changes nothing: no .corrupt file, no sink call', () => {
    expect(wal.readAll().map(e => e.id)).toEqual(['a', 'b']);
    expect(wal.pendingCount()).toBe(2);
    expect(existsSync(`${file}.corrupt`)).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('a line is quarantined once, however many operations meet it (a rejected update leaves it in the WAL)', () => {
    wal.updateEntryIf('a', () => false, { attempts: 9 });
    wal.updateEntryIf('a', () => false, { attempts: 9 });
    wal.updateEntry('zzz-unknown', {});
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(diagnostics).toHaveLength(1);
  });

  it('several corrupt lines are all kept, in order, in one report', () => {
    writeFileSync(file, [JSON.stringify(makeEntry('a')), 'garbage one', JSON.stringify(makeEntry('b')), 'garbage two'].join('\n') + '\n');
    wal.append(makeEntry('c'));
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe('garbage one\ngarbage two\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('2 unreadable line');
  });

  it.skipIf(process.platform === 'win32')('the .corrupt file is private (0600), like the WAL', () => {
    wal.append(makeEntry('c'));
    expect(statSync(`${file}.corrupt`).mode & 0o777).toBe(0o600);
  });

  it('without a sink the report goes to stderr, and the line is still kept', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    new Wal(file).append(makeEntry('c'));
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(CORRUPT + '\n');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`${file}.corrupt`));
  });

  it('when the line cannot be kept the operation still succeeds, and the sink says the line is lost and why', () => {
    // A directory in the place of the .corrupt file: nothing can be appended to it
    mkdirSync(`${file}.corrupt`);

    wal.append(makeEntry('c'));

    expect(wal.readAll().map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.level).toBe('warn');
    expect(diagnostics[0]!.message).toContain('could not be kept');
    expect(diagnostics[0]!.message).toContain(CORRUPT.slice(0, 40));
  });
});
