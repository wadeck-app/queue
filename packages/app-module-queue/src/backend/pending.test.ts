import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listPending } from './pending.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-pending-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const walLine = (id: string, status: string, extra: object = {}) => JSON.stringify({
  id, timestamp: '2026-10-19T10:00:00.000Z', event: 'onFoo', payload: { secret: 'token-123' }, meta: { cwd: '/p', projectName: 'p' }, subscriberId: 'onFoo[0]', status, attempts: 1, ...extra,
});

describe('listPending', () => {
  it('lists the events still on their way, without their payload, and the choices of the retry form', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('p 1', 'pending'), walLine('a1', 'acked'), walLine('f1', 'failed', { lastError: 'exit code 1' })].join('\n') + '\n');
    const result = listPending(configDir);
    expect(result.entries).toEqual([
      { id: 'p 1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'pending', attempts: 1, lastError: null, queuedAt: '2026-10-19T10:00:00.000Z' },
      { id: 'f1', event: 'onFoo', subscriberId: 'onFoo[0]', status: 'failed', attempts: 1, lastError: 'exit code 1', queuedAt: '2026-10-19T10:00:00.000Z' },
    ]);
    expect(result.options).toEqual([
      { value: 'p%201', label: 'onFoo / onFoo[0] (p 1)' },
      { value: 'f1', label: 'onFoo / onFoo[0] (f1)' },
    ]);
    expect(JSON.stringify(result)).not.toContain('token-123');
  });

  it('is empty without a WAL', () => {
    expect(listPending(configDir)).toEqual({ entries: [], options: [] });
  });
});
