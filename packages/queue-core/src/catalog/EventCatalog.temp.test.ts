import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCatalog, writeSourceDeclaration } from './EventCatalog.js';

const failure = { rename: false };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => {
      if (failure.rename) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.renameSync(from, to);
    }),
  };
});

const declaration = { source: 'task', events: [{ name: 'onTaskCreated', description: 'd' }] };

describe('writeSourceDeclaration temp files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-catalog-tmp-'));
    failure.rename = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('a rename that fails leaves no temp file behind, and the error reaches the caller', () => {
    failure.rename = true;
    expect(() => writeSourceDeclaration(dir, declaration)).toThrow('EXDEV');
    expect(readdirSync(join(dir, 'events'))).toEqual([]);
  });

  it('removes the temp file of a writer that died before its rename (dead pid), keeps the declarations', () => {
    writeSourceDeclaration(dir, { source: 'other', events: [{ name: 'onOther', description: 'd' }] });
    const stale = join(dir, 'events', 'task.json.99999999.tmp');
    writeFileSync(stale, '{"half');
    writeSourceDeclaration(dir, declaration);
    expect(readdirSync(join(dir, 'events')).sort()).toEqual(['other.json', 'task.json']);
    expect(readCatalog(dir).problems).toEqual([]);
  });

  it('removes a leftover of an older name scheme too (.<source>.<pid>.<time>.tmp), once it is old', () => {
    mkdirSync(join(dir, 'events'), { recursive: true });
    const legacy = join(dir, 'events', '.task.12345.1700000000000.tmp');
    writeFileSync(legacy, '{');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(legacy, old, old);
    writeSourceDeclaration(dir, declaration);
    expect(readdirSync(join(dir, 'events'))).toEqual(['task.json']);
  });
});
