import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wal, type WalEntry } from './storage/Wal.js';
import { abandonStuckEntries, countStuckEntries, STUCK_AFTER_MS } from './operations.js';

// An entry is stuck when nobody is going to retry it any more. How long that takes depends on its own retry plan: a subscriber with retries: 20 is legitimately
// waiting 16 minutes between attempts for hours, which the fixed two hours since its creation used to declare stuck.
let configDir: string;
const NOW = new Date('2026-11-08T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'queue-stuckplan-')); });
afterEach(() => rmSync(configDir, { recursive: true, force: true, maxRetries: 5 }));

function seed(id: string, overrides: Partial<WalEntry>): void {
  new Wal(join(configDir, 'wal.ndjson'), { now: () => NOW.getTime() }).append({ id, timestamp: ago(HOUR), event: 'onX', payload: {}, meta: { cwd: '/p' }, subscriberId: 's', status: 'failed', attempts: 1, ...overrides });
}

const stuck = (): number => countStuckEntries(configDir, { now: NOW });

describe('the stuck threshold follows the retry plan of the entry', () => {
  it('an entry written 5 hours ago whose next retry is due in 10 minutes is not stuck (a long retry plan)', () => {
    seed('long-plan', { timestamp: ago(5 * HOUR), retryDueAt: ahead(10 * MIN), attempts: 12 });
    expect(stuck()).toBe(0);
    expect(abandonStuckEntries(configDir, { now: NOW })).toEqual({ moved: 0 });
  });

  it('an entry whose retry was due long ago and never ran is stuck', () => {
    seed('lost', { timestamp: ago(10 * HOUR), retryDueAt: ago(3 * HOUR) });
    expect(stuck()).toBe(1);
  });

  it('boundary: the retry is overdue by exactly the margin: not stuck yet; one millisecond more: stuck', () => {
    seed('edge', { timestamp: ago(10 * HOUR), retryDueAt: ago(STUCK_AFTER_MS) });
    expect(stuck()).toBe(0);
    seed('over', { timestamp: ago(10 * HOUR), retryDueAt: ago(STUCK_AFTER_MS + 1) });
    expect(stuck()).toBe(1);
  });

  it('without a retry due time the threshold is still the age of the entry (entries written before it existed)', () => {
    seed('old-1h59', { timestamp: ago(STUCK_AFTER_MS - MIN) });
    expect(stuck()).toBe(0);
    seed('old-2h01', { timestamp: ago(STUCK_AFTER_MS + MIN) });
    expect(stuck()).toBe(1);
  });

  it('a due time before the creation time does not make the entry look older than it is', () => {
    seed('odd', { timestamp: ago(30 * MIN), retryDueAt: ago(5 * HOUR) });
    expect(stuck()).toBe(0);
  });

  it('an unreadable due time is ignored, the age of the entry decides', () => {
    seed('garbage', { timestamp: ago(3 * HOUR), retryDueAt: 'not a date' });
    expect(stuck()).toBe(1);
  });

  it('the caller can still choose the limit', () => {
    seed('plan', { timestamp: ago(HOUR), retryDueAt: ago(30 * MIN) });
    expect(countStuckEntries(configDir, { now: NOW, olderThanMs: 10 * MIN })).toBe(1);
    expect(countStuckEntries(configDir, { now: NOW, olderThanMs: HOUR })).toBe(0);
  });
});
