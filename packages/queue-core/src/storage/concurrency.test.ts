import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wal } from './Wal.js';
import { DlqStore } from './DlqStore.js';

/**
 * Several PROCESSES write the WAL / DLQ at once, as the daemon and app-core's queue module can. Before the file lock,
 * Wal and DlqStore rewrote the whole file through one shared ".tmp" name: concurrent writers lost entries and
 * crashed with ENOENT on the rename (measured: ~200 of 400 entries lost, one writer dead).
 */
const WRITERS = 3;
const PER_WRITER = 40;
const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, '../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-concurrency-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function walEntry(id: string) {
  return { id, timestamp: new Date().toISOString(), event: 'onRace', payload: { id }, meta: { cwd: '/', projectName: 'p' }, subscriberId: 's', status: 'pending' as const, attempts: 0 };
}

function dlqEntry(id: string) {
  return { id, event: 'onRace', payload: { id }, meta: { cwd: '/', projectName: 'p' }, subscriberId: 's', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() };
}

/** Runs the same script in WRITERS node processes (through tsx, straight from src) and returns their exit codes and stderr. */
async function runWriters(scriptBody: string): Promise<{ codes: number[]; stderr: string }> {
  const script = join(dir, 'writer.mjs');
  writeFileSync(
    script,
    `import { ${'Wal'}, } from ${JSON.stringify(pathToFileURL(join(srcDir, 'Wal.ts')).href)};\n` +
      `import { DlqStore } from ${JSON.stringify(pathToFileURL(join(srcDir, 'DlqStore.ts')).href)};\n` +
      `const [, , tag, walFile, dlqFile, count] = process.argv;\n` +
      `const wal = new Wal(walFile); const dlq = new DlqStore(dlqFile);\n` +
      scriptBody,
  );
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, `w${i}`, join(dir, 'wal.ndjson'), join(dir, 'dlq.ndjson'), String(PER_WRITER)], {
        cwd: packageDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
    })),
  );
  return { codes: results.map((r) => r.code), stderr: results.map((r) => r.stderr).join('') };
}

describe('Wal and DlqStore with several writer processes', () => {
  it('keeps every WAL entry and every update when processes append and update at once', async () => {
    const { codes, stderr } = await runWriters(
      `for (let i = 0; i < Number(count); i++) {\n` +
        `  const id = tag + '-' + i;\n` +
        `  wal.append({ id, timestamp: new Date().toISOString(), event: 'onRace', payload: { id }, meta: { cwd: '/', projectName: 'p' }, subscriberId: 's', status: 'pending', attempts: 0 });\n` +
        `  wal.updateEntry(id, { status: 'acked', attempts: 1 });\n` +
        `}\n`,
    );
    expect(stderr).toBe('');
    expect(codes).toEqual([0, 0, 0]);
    const entries = new Wal(join(dir, 'wal.ndjson')).readAll();
    expect(entries).toHaveLength(WRITERS * PER_WRITER);
    expect(entries.every((e) => e.status === 'acked' && e.attempts === 1)).toBe(true);
  });

  it('keeps every DLQ entry when processes append and remove at once', async () => {
    const { codes, stderr } = await runWriters(
      `for (let i = 0; i < Number(count); i++) {\n` +
        `  const id = tag + '-' + i;\n` +
        `  dlq.append({ id, event: 'onRace', payload: { id }, meta: { cwd: '/', projectName: 'p' }, subscriberId: 's', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() });\n` +
        `  if (i % 2 === 0) dlq.remove(id);\n` +
        `}\n`,
    );
    expect(stderr).toBe('');
    expect(codes).toEqual([0, 0, 0]);
    const ids = new DlqStore(join(dir, 'dlq.ndjson')).readAll().map((e) => e.id).sort();
    const expected = Array.from({ length: WRITERS }, (_, w) => Array.from({ length: PER_WRITER }, (_, i) => i).filter((i) => i % 2 === 1).map((i) => `w${w}-${i}`)).flat().sort();
    expect(ids).toEqual(expected);
  });

  it('a single process still works as before (append, update, remove)', () => {
    const wal = new Wal(join(dir, 'wal.ndjson'));
    wal.append(walEntry('a'));
    wal.updateEntry('a', { status: 'acked' });
    expect(wal.readAll()[0]!.status).toBe('acked');
    const dlq = new DlqStore(join(dir, 'dlq.ndjson'));
    dlq.append(dlqEntry('x'));
    dlq.remove('x');
    expect(dlq.readAll()).toEqual([]);
  });
});
