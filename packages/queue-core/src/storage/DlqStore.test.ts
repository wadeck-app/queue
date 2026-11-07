import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DlqStore } from './DlqStore.js';
import type { DlqEntry } from './DlqStore.js';

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: crypto.randomUUID(),
    event: 'test.event',
    payload: {},
    meta: { cwd: '/tmp' },
    subscriberId: 'sub-1',
    attempts: 3,
    lastError: 'timeout',
    movedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DlqStore', () => {
  let tmpDir: string;
  let dlq: DlqStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dlq-test-'));
    dlq = new DlqStore(join(tmpDir, 'dlq.ndjson'), 3);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append/readAll/remove round-trip', () => {
    const e = makeEntry({ id: 'abc' });
    dlq.append(e);
    expect(dlq.readAll()).toHaveLength(1);
    dlq.remove('abc');
    expect(dlq.readAll()).toHaveLength(0);
  });

  it('maxDlqSize pruning: oldest entry removed with stderr warn', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dlq.append(makeEntry({ id: 'first' }));
    dlq.append(makeEntry({ id: 'second' }));
    dlq.append(makeEntry({ id: 'third' }));
    // At max size now (3). Next append should prune oldest.
    dlq.append(makeEntry({ id: 'fourth' }));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('DLQ limit'));
    const all = dlq.readAll();
    expect(all).toHaveLength(3);
    expect(all.find(e => e.id === 'first')).toBeUndefined();
    expect(all.find(e => e.id === 'fourth')).toBeDefined();
    stderrWrite.mockRestore();
  });

  it('append reports inserted for a new id', () => {
    expect(dlq.append(makeEntry({ id: 'a' }))).toEqual({ inserted: true });
  });

  it('append is idempotent on the id: the row is replaced (and becomes the newest), never duplicated', () => {
    dlq.append(makeEntry({ id: 'a', lastError: 'first' }));
    dlq.append(makeEntry({ id: 'b' }));
    expect(dlq.append(makeEntry({ id: 'a', lastError: 'second' }))).toEqual({ inserted: false });
    const all = dlq.readAll();
    expect(all.map((e) => e.id)).toEqual(['b', 'a']);
    expect(all[1]!.lastError).toBe('second');
  });

  it('replacing an id at the cap evicts nothing', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const id of ['a', 'b', 'c']) {
      dlq.append(makeEntry({ id }));
    }
    expect(dlq.append(makeEntry({ id: 'b' }))).toEqual({ inserted: false });
    expect(dlq.readAll()).toHaveLength(3);
    expect(stderrWrite).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });

  it('eviction at the cap returns the dropped (oldest) entry, and still writes the stderr line', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const first = makeEntry({ id: 'first', payload: { n: 1 } });
    dlq.append(first);
    dlq.append(makeEntry({ id: 'second' }));
    dlq.append(makeEntry({ id: 'third' }));
    const result = dlq.append(makeEntry({ id: 'fourth' }));
    expect(result).toEqual({ inserted: true, evicted: first });
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('DLQ limit reached (3)'));
    expect(dlq.readAll().map((e) => e.id)).toEqual(['second', 'third', 'fourth']);
    stderrWrite.mockRestore();
  });

  it('removeEntries returns the removed entries (one id or several), ignores unknown ids', () => {
    const a = makeEntry({ id: 'a' });
    const b = makeEntry({ id: 'b' });
    dlq.append(a);
    dlq.append(b);
    dlq.append(makeEntry({ id: 'c' }));
    expect(dlq.removeEntries('nope')).toEqual([]);
    expect(dlq.removeEntries('a')).toEqual([a]);
    expect(dlq.removeEntries(['b', 'nope'])).toEqual([b]);
    expect(dlq.readAll().map((e) => e.id)).toEqual(['c']);
  });

  it('remove keeps returning a count', () => {
    dlq.append(makeEntry({ id: 'a' }));
    expect(dlq.remove('a')).toBe(1);
    expect(dlq.remove('a')).toBe(0);
  });

  it('clearEntries returns every removed entry and empties the file', () => {
    const a = makeEntry({ id: 'a' });
    const b = makeEntry({ id: 'b' });
    dlq.append(a);
    dlq.append(b);
    expect(dlq.clearEntries()).toEqual([a, b]);
    expect(dlq.readAll()).toEqual([]);
    expect(dlq.clearEntries()).toEqual([]);
  });

  it('clear removes all entries and returns count', () => {
    dlq.append(makeEntry());
    dlq.append(makeEntry());
    const count = dlq.clear();
    expect(count).toBe(2);
    expect(dlq.readAll()).toHaveLength(0);
  });
});
