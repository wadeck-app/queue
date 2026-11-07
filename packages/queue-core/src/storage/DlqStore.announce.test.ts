import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DlqStore } from './DlqStore.js';
import type { DlqEntry } from './DlqStore.js';

// The announcement mark of a DLQ row: `announce: 'pending'` until its queue.dlq.added event was emitted.

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    id: 'e1',
    event: 'onFoo',
    payload: {},
    meta: { cwd: '/tmp' },
    subscriberId: 'sub-1',
    attempts: 1,
    lastError: 'boom',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

let tmpDir: string;
let dlq: DlqStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dlq-announce-test-'));
  dlq = new DlqStore(join(tmpDir, 'dlq.ndjson'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DlqStore announcement mark', () => {
  it('get finds a row by id, and nothing for an unknown id', () => {
    dlq.append(makeEntry());
    expect(dlq.get('e1')?.id).toBe('e1');
    expect(dlq.get('nope')).toBeUndefined();
  });

  it('the mark and the facts needed to emit later are stored with the row', () => {
    dlq.append(makeEntry({ announce: 'pending', announceInfo: { reason: 'retries-exhausted', exitCode: 3, target: 'node x.js' } }));
    expect(dlq.readAll()[0]).toMatchObject({ announce: 'pending', announceInfo: { reason: 'retries-exhausted', exitCode: 3, target: 'node x.js' } });
  });

  it('setAnnounce(undefined) clears the mark and its facts in one write, leaving the rest of the row', () => {
    dlq.append(makeEntry({ announce: 'pending', announceInfo: { reason: 'permanent-failure' } }));
    expect(dlq.setAnnounce('e1', undefined)).toBe(true);
    const row = dlq.readAll()[0]!;
    expect(row).not.toHaveProperty('announce');
    expect(row).not.toHaveProperty('announceInfo');
    expect(row).toMatchObject({ id: 'e1', lastError: 'boom', attempts: 1 });
  });

  it('setAnnounce can set skipped, and says false for a row that is not there (nothing written)', () => {
    dlq.append(makeEntry({ announce: 'pending', announceInfo: { reason: 'retries-exhausted' } }));
    expect(dlq.setAnnounce('e1', 'skipped')).toBe(true);
    expect(dlq.readAll()[0]).toMatchObject({ announce: 'skipped', announceInfo: { reason: 'retries-exhausted' } });
    expect(dlq.setAnnounce('nope', undefined)).toBe(false);
    expect(dlq.readAll()).toHaveLength(1);
  });
});
