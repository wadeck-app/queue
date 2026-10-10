import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DlqStore } from './DlqStore.js';
import type { DlqEntry } from './DlqStore.js';

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: crypto.randomUUID(),
    event: 'test.event',
    payload: {},
    meta: { cwd: '/tmp' },
    subscriberId: 'sub-1',
    attempts: 3,
    lastError: 'timeout',
    movedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DlqStore', () => {
  let tmpDir: string;
  let dlq: DlqStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `dlq-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dlq = new DlqStore(join(tmpDir, 'dlq.ndjson'), 3);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append/readAll/remove round-trip', () => {
    const e = makeEntry({ id: 'abc' });
    dlq.append(e);
    expect(dlq.readAll()).toHaveLength(1);
    dlq.remove('abc');
    expect(dlq.readAll()).toHaveLength(0);
  });

  it('maxDlqSize pruning: oldest entry removed with stderr warn', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dlq.append(makeEntry({ id: 'first' }));
    dlq.append(makeEntry({ id: 'second' }));
    dlq.append(makeEntry({ id: 'third' }));
    // At max size now (3). Next append should prune oldest.
    dlq.append(makeEntry({ id: 'fourth' }));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('DLQ limit'));
    const all = dlq.readAll();
    expect(all).toHaveLength(3);
    expect(all.find(e => e.id === 'first')).toBeUndefined();
    expect(all.find(e => e.id === 'fourth')).toBeDefined();
    stderrWrite.mockRestore();
  });

  it('clear removes all entries and returns count', () => {
    dlq.append(makeEntry());
    dlq.append(makeEntry());
    const count = dlq.clear();
    expect(count).toBe(2);
    expect(dlq.readAll()).toHaveLength(0);
  });
});
