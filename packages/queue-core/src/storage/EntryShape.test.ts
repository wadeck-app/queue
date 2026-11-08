import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './Wal.js';
import { DlqStore, type DlqEntry } from './DlqStore.js';
import type { StorageDiagnostic } from './StorageDiagnostics.js';

const walEntry = (id: string, overrides: Partial<WalEntry> = {}): WalEntry => ({ id, timestamp: new Date().toISOString(), event: 'onX', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', status: 'pending', attempts: 0, ...overrides });
const dlqEntry = (id: string, overrides: Partial<DlqEntry> = {}): DlqEntry => ({ id, event: 'onX', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', attempts: 1, lastError: 'boom', movedAt: new Date().toISOString(), ...overrides });

// Valid JSON that is not an entry: every read and append used to crash on it ("Cannot read properties of null")
const NOT_ENTRIES = ['null', '123', '"x"', '[1,2]', 'true', '{}', '{"id":"x"}', '{"id":7,"status":"pending"}'];

describe.each([
  ['Wal', 'wal.ndjson', 'Wal'],
  ['DlqStore', 'dlq.ndjson', 'DlqStore'],
])('%s lines that are valid JSON but not an entry', (_name, fileName, source) => {
  let dir: string;
  let file: string;
  let diagnostics: StorageDiagnostic[];
  const make = (): { readAll(): { id: string }[]; add(id: string): void } => {
    if (source === 'Wal') {
      const wal = new Wal(file, { onDiagnostic: (d) => diagnostics.push(d) });
      return { readAll: () => wal.readAll(), add: (id) => wal.append(walEntry(id)) };
    }
    const dlq = new DlqStore(file, undefined, { onDiagnostic: (d) => diagnostics.push(d) });
    return { readAll: () => dlq.readAll(), add: (id) => { dlq.append(dlqEntry(id)); } };
  };
  const good = (id: string): string => JSON.stringify(source === 'Wal' ? walEntry(id) : dlqEntry(id));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-shape-'));
    file = join(dir, fileName);
    diagnostics = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  it.each(NOT_ENTRIES)('readAll skips %s and keeps the good lines', (bad) => {
    writeFileSync(file, `${good('a')}\n${bad}\n${good('b')}\n`);
    expect(make().readAll().map((e) => e.id)).toEqual(['a', 'b']);
  });

  it.each(NOT_ENTRIES)('an append quarantines %s to the .corrupt file and says why', (bad) => {
    writeFileSync(file, `${good('a')}\n${bad}\n`);
    const store = make();
    store.add('c');
    expect(store.readAll().map((e) => e.id)).toEqual(['a', 'c']);
    expect(readFileSync(`${file}.corrupt`, 'utf-8')).toBe(`${bad}\n`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ source, level: 'warn' });
    expect(diagnostics[0]!.message).toContain(`${file}.corrupt`);
    expect(diagnostics[0]!.message).toContain('not a');
  });

  it('a read alone writes nothing', () => {
    writeFileSync(file, `null\n${good('a')}\n`);
    make().readAll();
    expect(existsSync(`${file}.corrupt`)).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('an unknown status is quarantined (WAL only: the DLQ row has no status)', () => {
    if (source !== 'Wal') {
      return;
    }
    const odd = JSON.stringify({ ...walEntry('z'), status: 'weird' });
    writeFileSync(file, `${odd}\n`);
    expect(make().readAll()).toEqual([]);
  });
});

describe('an entry without the fields the readers dereference', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-shape-meta-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('a WAL entry without meta is not an entry (entry.meta.cwd would throw)', () => {
    const { meta: _meta, ...noMeta } = walEntry('m');
    writeFileSync(join(dir, 'wal.ndjson'), JSON.stringify(noMeta) + '\n');
    expect(new Wal(join(dir, 'wal.ndjson')).readAll()).toEqual([]);
  });

  it('a DLQ row without meta is not an entry', () => {
    const { meta: _meta, ...noMeta } = dlqEntry('m');
    writeFileSync(join(dir, 'dlq.ndjson'), JSON.stringify(noMeta) + '\n');
    expect(new DlqStore(join(dir, 'dlq.ndjson')).readAll()).toEqual([]);
  });
});
