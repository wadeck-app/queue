import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listHistory, getHistoryEntry } from './history.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-app-module-history-'));
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeDay(date: string, records: Record<string, unknown>[]): void {
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), lines);
}

describe('listHistory', () => {
  it('returns an empty array when no history dir content exists', () => {
    expect(listHistory(configDir)).toEqual([]);
  });

  it('reads trigger + outcome records into a combined entry', () => {
    writeDay('2026-01-01', [
      { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 } },
      { type: 'outcome', ts: '2026-01-01T00:00:01.000Z', eventId: 'e1', event: 'onFoo', subscriberId: 'sub1', status: 'success' },
    ]);
    const entries = listHistory(configDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ eventId: 'e1', event: 'onFoo', payload: { a: 1 }, orphan: false });
    expect(entries[0].subscribers).toEqual([{ subscriberId: 'sub1', status: 'success', target: undefined }]);
  });

  it('applies the event filter', () => {
    writeDay('2026-01-01', [
      { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 0, totalCount: 0 },
      { type: 'trigger', ts: '2026-01-01T00:00:01.000Z', eventId: 'e2', event: 'onBar', matchedCount: 0, totalCount: 0 },
    ]);
    expect(listHistory(configDir, { event: 'onBar' }).map(e => e.eventId)).toEqual(['e2']);
  });
});

describe('getHistoryEntry', () => {
  it('finds an entry by eventId', () => {
    writeDay('2026-01-01', [{ type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 0, totalCount: 0 }]);
    expect(getHistoryEntry(configDir, 'e1')?.event).toBe('onFoo');
  });

  it('returns undefined for an unknown eventId', () => {
    expect(getHistoryEntry(configDir, 'does-not-exist')).toBeUndefined();
  });
});
