import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal } from './storage/Wal.js';
import { DlqStore } from './storage/DlqStore.js';
import { readQueueCounts, listDlqEntries, clearDlqEntries, listQueueSubscribers } from './operations.js';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-ops-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-ops-project-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const meta = { cwd: '/p', projectName: 'p' };

function walEntry(id: string, status: 'pending' | 'acked' | 'failed' | 'dlq') {
  return { id, timestamp: new Date().toISOString(), ackedAt: new Date().toISOString(), event: 'onFoo', payload: {}, meta, subscriberId: 's', status, attempts: 0 };
}

function dlqEntry(id: string) {
  return { id, event: 'onFoo', payload: { id }, meta, subscriberId: 's', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() };
}

describe('readQueueCounts', () => {
  it('is zero for a config dir that has no WAL or DLQ yet', () => {
    expect(readQueueCounts(configDir)).toEqual({ pendingCount: 0, dlqCount: 0 });
  });

  it('counts the pending WAL entries and the DLQ entries from the files, without any daemon', () => {
    const wal = new Wal(join(configDir, 'wal.ndjson'));
    wal.append(walEntry('a', 'pending'));
    wal.append(walEntry('b', 'pending'));
    wal.append(walEntry('c', 'acked'));
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('x'));
    expect(readQueueCounts(configDir)).toEqual({ pendingCount: 2, dlqCount: 1 });
  });
});

describe('listDlqEntries / clearDlqEntries', () => {
  beforeEach(() => {
    const dlq = new DlqStore(join(configDir, 'dlq.ndjson'));
    dlq.append(dlqEntry('x'));
    dlq.append(dlqEntry('y'));
  });

  it('lists the entries', () => {
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['x', 'y']);
  });

  it('clears one entry by id and reports 1', () => {
    expect(clearDlqEntries(configDir, 'x')).toBe(1);
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['y']);
  });

  it('clears everything when no id is given and reports how many', () => {
    expect(clearDlqEntries(configDir)).toBe(2);
    expect(listDlqEntries(configDir)).toEqual([]);
  });
});

describe('listQueueSubscribers', () => {
  function writeProjectSubscribers(content: string): void {
    mkdirSync(join(projectDir, '.queue'), { recursive: true });
    writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), content);
  }

  it('lists every subscriber configured for the project', () => {
    writeProjectSubscribers('subscribers:\n  onA:\n    - type: cli\n      command: echo a\n  onB:\n    - type: cli\n      command: echo b\n');
    expect(listQueueSubscribers(configDir, { cwd: projectDir }).map(s => s.event).sort()).toEqual(['onA', 'onB']);
  });

  it('filters to the subscribers matching one event', () => {
    writeProjectSubscribers('subscribers:\n  onA:\n    - type: cli\n      command: echo a\n  onB:\n    - type: cli\n      command: echo b\n');
    expect(listQueueSubscribers(configDir, { cwd: projectDir, event: 'onB' }).map(s => s.event)).toEqual(['onB']);
  });

  it('lets an invalid subscribers.yml surface as an error (never an empty list)', () => {
    writeProjectSubscribers('subscribers: [this is not valid\n');
    expect(() => listQueueSubscribers(configDir, { cwd: projectDir })).toThrow();
  });
});

describe('clearDlqEntries with an unknown id', () => {
  it('reports 0 instead of pretending something was cleared', () => {
    new DlqStore(join(configDir, 'dlq.ndjson')).append(dlqEntry('x'));
    expect(clearDlqEntries(configDir, 'nope')).toBe(0);
    expect(listDlqEntries(configDir).map(e => e.id)).toEqual(['x']);
  });
});
