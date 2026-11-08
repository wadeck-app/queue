import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DlqStore, type DlqEntry } from './DlqStore.js';
import { Wal } from './Wal.js';

// File modes cannot be read back on Windows, so the request itself is checked: every temp file and every .corrupt file is created with mode 0600
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), appendFileSync: vi.fn(actual.appendFileSync) };
});

// The temp files are opened by writeFileDurably (open, write, fsync), the mode is the third argument of openSync
const writeMock = vi.mocked(openSync);
const appendMock = vi.mocked(appendFileSync);

const row: DlqEntry = { id: 'a', event: 'e', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', attempts: 1, lastError: 'x', movedAt: '2026-10-19T10:00:00.000Z' };

describe('private modes of the queue temp and quarantine files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-modes-'));
    writeMock.mockClear();
    appendMock.mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const modeOf = (mock: typeof writeMock | typeof appendMock, suffix: string): unknown => {
    const call = mock.mock.calls.find(c => String(c[0]).endsWith(suffix));
    if (call === undefined) {
      throw new Error(`no call wrote a file ending with ${suffix}`);
    }
    const options = call[2] as { mode?: number } | number | undefined;
    return typeof options === 'number' ? options : options?.mode;
  };

  it('the DLQ temp file is written 0600, like the WAL one', () => {
    new DlqStore(join(dir, 'dlq.ndjson')).append(row);
    expect(modeOf(writeMock, '.tmp')).toBe(0o600);
    writeMock.mockClear();
    new Wal(join(dir, 'wal.ndjson')).append({ id: 'w', timestamp: 't', event: 'e', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', status: 'pending', attempts: 0 });
    expect(modeOf(writeMock, '.tmp')).toBe(0o600);
  });

  it('the .corrupt files are created 0600', () => {
    writeFileSync(join(dir, 'dlq.ndjson'), 'garbage\n');
    writeFileSync(join(dir, 'wal.ndjson'), 'garbage\n');
    new DlqStore(join(dir, 'dlq.ndjson'), 10, { onDiagnostic: () => undefined }).append(row);
    new Wal(join(dir, 'wal.ndjson'), { onDiagnostic: () => undefined }).upsert({ id: 'w', timestamp: 't', event: 'e', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', status: 'pending', attempts: 0 });
    expect(modeOf(appendMock, 'dlq.ndjson.corrupt')).toBe(0o600);
    expect(modeOf(appendMock, 'wal.ndjson.corrupt')).toBe(0o600);
  });
});
