import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOverviewRange, OVERVIEW_RANGES, DEFAULT_OVERVIEW_RANGE } from './overviewRange.js';
import { InvalidQueryError } from './errors.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-01-08T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-overview-'));
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeRecords(date: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

const trigger = (atMs: number, id: string) => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: id, event: 'onFoo', matchedCount: 0, totalCount: 0 });
const outcome = (atMs: number, status: 'success' | 'failed' | 'dlq') => ({
  ts: new Date(atMs).toISOString(),
  type: 'outcome',
  eventId: 'e',
  subscriberId: 'onFoo[0]',
  status,
});

describe('the periods of the overview', () => {
  it('offer 1 h, 6 h, 24 h, 3 d and 7 d, 24 h by default', () => {
    expect(OVERVIEW_RANGES.map((range) => range.value)).toEqual(['1h', '6h', '24h', '3d', '7d']);
    expect(DEFAULT_OVERVIEW_RANGE).toBe('24h');
  });

  it('keep every chart readable: between 12 and 72 slices', () => {
    for (const range of OVERVIEW_RANGES) {
      expect(range.slices, range.value).toBeGreaterThanOrEqual(12);
      expect(range.slices, range.value).toBeLessThanOrEqual(72);
    }
  });

  it('cover exactly the period they name', () => {
    const periodMs = { '1h': HOUR, '6h': 6 * HOUR, '24h': 24 * HOUR, '3d': 72 * HOUR, '7d': 7 * 24 * HOUR };
    for (const range of OVERVIEW_RANGES) {
      expect(range.sliceMs * range.slices, range.value).toBe(periodMs[range.value as keyof typeof periodMs]);
    }
  });
});

describe('getOverviewRange', () => {
  it('defaults to the last 24 hours in one-hour slices', () => {
    const overview = getOverviewRange(configDir, undefined, NOW);
    expect(overview.range).toBe('24h');
    expect(overview.events).toHaveLength(24);
    expect(overview.sliceLabel).toBe('hour');
  });

  it('counts the events pushed in the period and plots them per slice, the last slice being the current one', () => {
    writeRecords('2026-01-08', [trigger(NOW - 2 * MINUTE, 'a'), trigger(NOW - 3 * MINUTE, 'b'), trigger(NOW - 40 * MINUTE, 'c')]);
    const overview = getOverviewRange(configDir, '1h', NOW);
    expect(overview.events).toHaveLength(12);
    expect(overview.totals.events).toBe(3);
    expect(overview.events.reduce((total, point) => total + point.events, 0)).toBe(3);
    // NOW is exactly on a slice boundary: the current slice [12:00, 12:05) is empty, the two events sit in [11:55, 12:00)
    expect(overview.events[11]?.events).toBe(0);
    expect(overview.events[10]?.events).toBe(2);
  });

  it('a longer period reaches further back: an event 2 days old is in 3 d and 7 d but not in 24 h', () => {
    writeRecords('2026-01-06', [trigger(NOW - 2 * 24 * HOUR, 'old')]);
    expect(getOverviewRange(configDir, '24h', NOW).totals.events).toBe(0);
    expect(getOverviewRange(configDir, '3d', NOW).totals.events).toBe(1);
    expect(getOverviewRange(configDir, '7d', NOW).totals.events).toBe(1);
  });

  it('counts how the dispatches ended in the same period, with the failures per slice', () => {
    writeRecords('2026-01-08', [outcome(NOW - HOUR, 'success'), outcome(NOW - HOUR, 'success'), outcome(NOW - 2 * HOUR, 'failed'), outcome(NOW - 30 * MINUTE, 'dlq')]);
    const overview = getOverviewRange(configDir, '6h', NOW);
    expect(overview.totals).toMatchObject({ delivered: 2, failedAttempts: 1, givenUp: 1 });
    expect(overview.hasFailures).toBe(true);
    expect(overview.failures).toHaveLength(overview.events.length);
    expect(overview.failures.reduce((total, point) => total + point.failedAttempts + point.givenUp, 0)).toBe(2);
  });

  it('has no failures to draw when nothing failed', () => {
    writeRecords('2026-01-08', [outcome(NOW - HOUR, 'success')]);
    expect(getOverviewRange(configDir, '24h', NOW).hasFailures).toBe(false);
  });

  it('labels a period of several days with the date, because HH:MM alone repeats', () => {
    const labels = getOverviewRange(configDir, '7d', NOW).events.map((point) => point.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('labels a period of one day or less with the time only', () => {
    expect(getOverviewRange(configDir, '6h', NOW).events[0]?.label).toMatch(/^\d{2}:\d{2}$/);
  });

  it('says which period it covers, in words', () => {
    expect(getOverviewRange(configDir, '6h', NOW).title).toBe('Last 6 hours');
  });

  it('rejects an unknown period with the periods it accepts', () => {
    expect(() => getOverviewRange(configDir, '2w', NOW)).toThrow(InvalidQueryError);
    expect(() => getOverviewRange(configDir, '2w', NOW)).toThrow(/1h, 6h, 24h, 3d, 7d/);
  });

  it('ranks the most pushed events and the busiest subscribers of the same period', () => {
    writeRecords('2026-01-08', [trigger(NOW - HOUR, 'a'), trigger(NOW - 2 * HOUR, 'b'), outcome(NOW - HOUR, 'success')]);
    const overview = getOverviewRange(configDir, '6h', NOW);
    expect(overview.topEvents).toEqual([{ event: 'onFoo', count: 2 }]);
    expect(overview.subscribers).toMatchObject([{ subscriberId: 'onFoo[0]', delivered: 1 }]);
  });

  it('ranks over the period it covers: an event 2 days old is ranked in 3 d, not in 24 h', () => {
    writeRecords('2026-01-06', [trigger(NOW - 2 * 24 * HOUR, 'old')]);
    expect(getOverviewRange(configDir, '24h', NOW).topEvents).toEqual([]);
    expect(getOverviewRange(configDir, '3d', NOW).topEvents).toEqual([{ event: 'onFoo', count: 1 }]);
  });

  it('is all zeros when nothing was recorded', () => {
    const overview = getOverviewRange(join(configDir, 'nowhere'), '24h', NOW);
    expect(overview.totals).toEqual({ events: 0, delivered: 0, failedAttempts: 0, givenUp: 0 });
  });
});
