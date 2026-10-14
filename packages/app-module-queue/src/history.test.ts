import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listHistory, getHistoryEntry } from './history.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-queue-history-'));
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
  it('returns an empty page when no history dir content exists', () => {
    expect(listHistory(configDir)).toEqual({ entries: [], total: 0, limit: 20, offset: 0 });
  });

  it('reads trigger + outcome records into a combined entry', () => {
    writeDay('2026-01-01', [
      { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 1, totalCount: 1, payload: { a: 1 } },
      { type: 'outcome', ts: '2026-01-01T00:00:01.000Z', eventId: 'e1', event: 'onFoo', subscriberId: 'sub1', status: 'success' },
    ]);
    const page = listHistory(configDir);
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.entries[0]).toMatchObject({ eventId: 'e1', event: 'onFoo', payload: { a: 1 }, orphan: false });
    expect(page.entries[0].subscribers).toEqual([{ subscriberId: 'sub1', status: 'success', target: undefined }]);
  });

  it('applies the event filter', () => {
    writeDay('2026-01-01', [
      { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 0, totalCount: 0 },
      { type: 'trigger', ts: '2026-01-01T00:00:01.000Z', eventId: 'e2', event: 'onBar', matchedCount: 0, totalCount: 0 },
    ]);
    expect(listHistory(configDir, { event: 'onBar' }).entries.map(e => e.eventId)).toEqual(['e2']);
  });

  it('applies limit/offset pagination, defaulting to 20', () => {
    const records = Array.from({ length: 25 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const defaultPage = listHistory(configDir);
    expect(defaultPage.entries).toHaveLength(20);
    expect(defaultPage.total).toBe(25);

    const customPage = listHistory(configDir, {}, { limit: 5, offset: 20 });
    expect(customPage.entries).toHaveLength(5);
    expect(customPage.entries[0]!.eventId).toBe('e4');
  });

  it('accepts page parameter: page=0 with limit=5 returns first 5 entries', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page = listHistory(configDir, {}, { limit: 5, page: 0 });
    expect(page.entries).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(0);
    expect(page.entries[0]!.eventId).toBe('e11'); // newest first
  });

  it('accepts page parameter: page=1 with limit=5 returns second 5 entries', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page = listHistory(configDir, {}, { limit: 5, page: 1 });
    expect(page.entries).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(5);
    expect(page.entries[0]!.eventId).toBe('e6');
  });

  it('accepts page parameter: page=2 with limit=5 returns last partial page', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page = listHistory(configDir, {}, { limit: 5, page: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(12);
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(10);
    expect(page.entries[0]!.eventId).toBe('e1');
  });

  it('accepts page parameter: page beyond end returns empty entries but correct total/offset', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page = listHistory(configDir, {}, { limit: 5, page: 5 });
    expect(page.entries).toHaveLength(0);
    expect(page.total).toBe(12);
    expect(page.limit).toBe(5);
    expect(page.offset).toBe(25);
  });

  it('accepts page parameter: page without limit uses default limit=20', () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page = listHistory(configDir, {}, { page: 1 });
    // page=1 with default limit=20 means offset=20
    expect(page.entries).toHaveLength(20);
    expect(page.total).toBe(50);
    expect(page.limit).toBe(20);
    expect(page.offset).toBe(20);
  });

  it('total always equals number of matching entries across all pages, not filtered by limit/offset', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({
      type: 'trigger', ts: `2026-01-01T${String(i).padStart(2, '0')}:00:00.000Z`, eventId: `e${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0,
    }));
    writeDay('2026-01-01', records);
    const page0 = listHistory(configDir, {}, { limit: 5, page: 0 });
    const page1 = listHistory(configDir, {}, { limit: 5, page: 1 });
    expect(page0.total).toBe(12);
    expect(page1.total).toBe(12);
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
