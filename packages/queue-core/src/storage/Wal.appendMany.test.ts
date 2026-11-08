import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './Wal.js';

const failure = { rename: false };
const renames: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => {
      renames.push(to);
      if (failure.rename) {
        throw Object.assign(new Error('EXDEV: cannot rename'), { code: 'EXDEV' });
      }
      return actual.renameSync(from, to);
    }),
  };
});

const entry = (id: string): WalEntry => ({ id, timestamp: new Date().toISOString(), event: 'onX', payload: {}, meta: {}, subscriberId: `s-${id}`, status: 'pending', attempts: 0 });

describe('Wal.appendMany', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wal-many-'));
    file = join(dir, 'wal.ndjson');
    failure.rename = false;
    renames.length = 0;
    vi.mocked(renameSync).mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('records every entry, in order, with a single rewrite of the file', () => {
    const wal = new Wal(file);
    wal.append(entry('first'));
    renames.length = 0;
    wal.appendMany([entry('a'), entry('b'), entry('c')]);
    expect(wal.readAll().map((e) => e.id)).toEqual(['first', 'a', 'b', 'c']);
    expect(renames).toHaveLength(1);
  });

  it('is all or nothing: a write that fails records none of the entries', () => {
    const wal = new Wal(file);
    wal.append(entry('before'));
    failure.rename = true;
    expect(() => wal.appendMany([entry('a'), entry('b')])).toThrow('EXDEV');
    failure.rename = false;
    expect(wal.readAll().map((e) => e.id)).toEqual(['before']);
  });

  it('an empty list writes nothing, not even the file', () => {
    new Wal(file).appendMany([]);
    expect(existsSync(file)).toBe(false);
    expect(renames).toHaveLength(0);
  });

  it('applies the same retention as append', () => {
    const wal = new Wal(file, { maxRetainedAcked: 1 });
    wal.appendMany([
      { ...entry('old'), status: 'acked', ackedAt: new Date(Date.now() - 2000).toISOString() },
      { ...entry('new'), status: 'acked', ackedAt: new Date(Date.now() - 1000).toISOString() },
    ]);
    wal.appendMany([entry('p')]);
    expect(readFileSync(file, 'utf-8')).not.toContain('"old"');
    expect(wal.readAll().map((e) => e.id)).toEqual(['new', 'p']);
  });
});
