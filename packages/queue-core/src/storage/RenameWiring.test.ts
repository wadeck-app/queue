import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './Wal.js';
import { DlqStore, type DlqEntry } from './DlqStore.js';
import { readCatalog, writeSourceDeclaration } from '../catalog/EventCatalog.js';

// The wiring of the transient-EPERM retry: Wal and DlqStore must replace their file through renameReplacing. A direct renameSync in either would
// fail the whole operation on the first EPERM a scanner causes (the intermittent failure the retry was added for), and nothing else proved it.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const renameMock = vi.mocked(renameSync);

function eperm(): Error {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

function walEntry(id: string, overrides: Partial<WalEntry> = {}): WalEntry {
  return { id, timestamp: new Date().toISOString(), event: 'test.event', payload: { x: 1 }, meta: { cwd: '/tmp' }, subscriberId: 'sub-1', status: 'pending', attempts: 0, ...overrides };
}

function dlqEntry(id: string): DlqEntry {
  return { id, event: 'test.event', payload: { x: 1 }, meta: { cwd: '/tmp' }, subscriberId: 'sub-1', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() };
}

describe('Wal, DlqStore and the event catalog replace their file through the transient-EPERM retry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-rename-wiring-'));
    renameMock.mockClear();
  });

  afterEach(() => {
    renameMock.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  // The next rename of a data file fails with EPERM once (as a scanner holding the file does), then really renames
  const failOnce = (): void => {
    const real = renameMock.getMockImplementation()!;
    renameMock.mockImplementationOnce(() => {
      renameMock.mockImplementation(real);
      throw eperm();
    });
  };

  it('Wal.append survives one EPERM and the entry is stored', () => {
    const wal = new Wal(join(dir, 'wal.ndjson'));
    failOnce();
    wal.append(walEntry('a'));
    expect(wal.readAll().map(e => e.id)).toEqual(['a']);
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(renameMock.mock.calls[0]![0])).toMatch(/\.tmp$/);
  });

  it('Wal.updateEntry survives one EPERM and the update is stored', () => {
    const wal = new Wal(join(dir, 'wal.ndjson'));
    wal.append(walEntry('a'));
    renameMock.mockClear();
    failOnce();
    wal.updateEntry('a', { status: 'acked', ackedAt: new Date().toISOString() });
    expect(wal.readAll()[0]!.status).toBe('acked');
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('DlqStore.append survives one EPERM (first write, the file does not exist yet) and the row is stored', () => {
    const dlq = new DlqStore(join(dir, 'dlq.ndjson'));
    failOnce();
    expect(dlq.append(dlqEntry('d1')).inserted).toBe(true);
    expect(dlq.readAll().map(e => e.id)).toEqual(['d1']);
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('DlqStore.remove survives one EPERM and the row is gone', () => {
    const dlq = new DlqStore(join(dir, 'dlq.ndjson'));
    dlq.append(dlqEntry('d1'));
    dlq.append(dlqEntry('d2'));
    renameMock.mockClear();
    failOnce();
    expect(dlq.remove('d1')).toBe(1);
    expect(dlq.readAll().map(e => e.id)).toEqual(['d2']);
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('writeSourceDeclaration (event catalog) survives one EPERM and the declaration is stored', () => {
    failOnce();
    writeSourceDeclaration(dir, { source: 'task', events: [{ name: 'onTaskCreated', description: 'A task was created.' }] }, new Date('2026-10-24T10:00:00.000Z'));
    const catalog = readCatalog(dir);
    expect(catalog.problems).toEqual([]);
    expect(catalog.sources.map(s => s.source)).toEqual(['task']);
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(renameMock.mock.calls[0]![0])).toMatch(/\.tmp$/);
  });
});
