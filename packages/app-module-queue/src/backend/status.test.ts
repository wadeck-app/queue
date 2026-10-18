import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStatus } from './status.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-status-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

const meta = { cwd: '/p', projectName: 'p' };
const walLine = (id: string, status: string) => JSON.stringify({ id, timestamp: '2026-10-18T12:00:00.000Z', event: 'onFoo', payload: {}, meta, subscriberId: 's', status, attempts: 0, ackedAt: new Date().toISOString() });
const dlqLine = (id: string) => JSON.stringify({ id, event: 'onFoo', payload: {}, meta, subscriberId: 's', attempts: 3, lastError: 'x', movedAt: '2026-10-18T12:00:00.000Z' });

describe('getStatus', () => {
  it('reports zero counts for a queue that never ran', () => {
    expect(getStatus(configDir)).toEqual({ pendingCount: 0, dlqCount: 0 });
  });

  it('reads the pending and DLQ counts from the queue files, with no daemon involved', () => {
    writeFileSync(join(configDir, 'wal.ndjson'), [walLine('a', 'pending'), walLine('b', 'pending'), walLine('c', 'acked')].join('\n') + '\n');
    writeFileSync(join(configDir, 'dlq.ndjson'), dlqLine('x') + '\n');
    expect(getStatus(configDir)).toEqual({ pendingCount: 2, dlqCount: 1 });
  });

  it('does not claim anything about the daemon (the process answering is app-core, not the daemon)', () => {
    expect(Object.keys(getStatus(configDir)).sort()).toEqual(['dlqCount', 'pendingCount']);
  });
});
