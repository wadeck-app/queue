import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, renameSync, fsyncSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './Wal.js';
import { DlqStore, type DlqEntry } from './DlqStore.js';
import { writeFileDurably } from './AtomicRename.js';
import { writeSourceDeclaration } from '../catalog/EventCatalog.js';
import { dlqEntry, walEntry } from '../queueEntries.testUtil.js';

// A power loss between the rename and the disk flush can leave the renamed file empty or truncated: the temp file is flushed (fsync) BEFORE it replaces the data file
const calls: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => { calls.push(`rename:${to}`); return actual.renameSync(from, to); }),
    fsyncSync: vi.fn((fd: number) => { calls.push('fsync'); return actual.fsyncSync(fd); }),
  };
});


describe('data files are flushed before they replace the previous version', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-durable-'));
    calls.length = 0;
    vi.mocked(renameSync).mockClear();
    vi.mocked(fsyncSync).mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  const expectFlushedThenRenamed = (target: string): void => {
    const renameAt = calls.findIndex((c) => c === `rename:${target}`);
    expect(renameAt).toBeGreaterThan(-1);
    expect(calls.slice(0, renameAt)).toContain('fsync');
  };

  it('Wal', () => {
    new Wal(join(dir, 'wal.ndjson')).append(walEntry('a'));
    expectFlushedThenRenamed(join(dir, 'wal.ndjson'));
  });

  it('DlqStore', () => {
    new DlqStore(join(dir, 'dlq.ndjson')).append(dlqEntry('a'));
    expectFlushedThenRenamed(join(dir, 'dlq.ndjson'));
  });

  it('the event catalog', () => {
    writeSourceDeclaration(dir, { source: 'task', events: [{ name: 'onTaskCreated', description: 'd' }] });
    expectFlushedThenRenamed(join(dir, 'events', 'task.json'));
  });

  it('writeFileDurably writes the content, flushes the same descriptor it wrote to, then closes it', () => {
    const log: string[] = [];
    writeFileDurably(join(dir, 'f'), 'hello', 0o600, {
      openSync: () => { log.push('open'); return 42; },
      writeSync: (fd, text) => { log.push(`write:${fd}:${text}`); return Buffer.byteLength(text); },
      fsyncSync: (fd) => { log.push(`fsync:${fd}`); },
      closeSync: (fd) => { log.push(`close:${fd}`); },
    });
    expect(log).toEqual(['open', 'write:42:hello', 'fsync:42', 'close:42']);
  });

  it('writeFileDurably closes the descriptor when the flush fails, and the error reaches the caller', () => {
    const log: string[] = [];
    expect(() => writeFileDurably(join(dir, 'f'), 'x', 0o600, {
      openSync: () => 7,
      writeSync: (_fd, text) => Buffer.byteLength(text),
      fsyncSync: () => { throw new Error('EIO'); },
      closeSync: (fd) => { log.push(`close:${fd}`); },
    })).toThrow('EIO');
    expect(log).toEqual(['close:7']);
  });

  it('writeFileDurably really writes a file with the default fs', () => {
    writeFileDurably(join(dir, 'real'), 'abc\n', 0o600);
    expect(readFileSync(join(dir, 'real'), 'utf-8')).toBe('abc\n');
  });
});
