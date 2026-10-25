import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBreakdown, TOP_EVENTS, TOP_SUBSCRIBERS } from './breakdown.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-01-02T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-breakdown-'));
  mkdirSync(join(configDir, 'history'));
  mkdirSync(join(configDir, 'logs'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeHistory(date: string, records: object[]): void {
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeLog(date: string, records: object[]): void {
  writeFileSync(join(configDir, 'logs', `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const trigger = (event: string, atMs = NOW - MINUTE) => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: crypto.randomUUID(), event, matchedCount: 0, totalCount: 0 });
const outcome = (subscriberId: string, status: string, atMs = NOW - MINUTE) => ({ ts: new Date(atMs).toISOString(), type: 'outcome', eventId: crypto.randomUUID(), event: 'onFoo', subscriberId, status });
const dispatch = (subscriberId: string, durationMs: number, atMs = NOW - MINUTE) => ({ ts: new Date(atMs).toISOString(), type: 'dispatch', event: 'onFoo', subscriberId, status: 'success', durationMs });

describe('getBreakdown', () => {
  it('lists the most pushed events first, ties by name, and totals the rest', () => {
    const records = [
      ...Array.from({ length: 5 }, () => trigger('onBusy')),
      ...Array.from({ length: 2 }, () => trigger('onB')),
      ...Array.from({ length: 2 }, () => trigger('onA')),
      trigger('onOld', NOW - 30 * HOUR),
    ];
    writeHistory('2026-01-02', records);
    const { topEvents, otherEvents } = getBreakdown(configDir, NOW);
    expect(topEvents).toEqual([{ event: 'onBusy', count: 5 }, { event: 'onA', count: 2 }, { event: 'onB', count: 2 }]);
    expect(otherEvents).toBe(0);
  });

  it(`keeps ${TOP_EVENTS} events and counts the others together`, () => {
    writeHistory('2026-01-02', Array.from({ length: TOP_EVENTS + 3 }, (_, i) => trigger(`on${String(i).padStart(2, '0')}`)));
    const { topEvents, otherEvents } = getBreakdown(configDir, NOW);
    expect(topEvents).toHaveLength(TOP_EVENTS);
    expect(otherEvents).toBe(3);
  });

  it('says what the top leaves out in one line, and nothing when there is nothing', () => {
    writeHistory('2026-01-02', Array.from({ length: TOP_EVENTS + 1 }, (_, i) => trigger(`on${String(i).padStart(2, '0')}`)));
    expect(getBreakdown(configDir, NOW).otherText).toBe('1 more push of other events');
    writeHistory('2026-01-02', Array.from({ length: TOP_EVENTS + 4 }, (_, i) => trigger(`on${String(i).padStart(2, '0')}`)));
    expect(getBreakdown(configDir, NOW).otherText).toBe('4 more pushes of other events');
  });

  it('gives each subscriber its outcomes and, from the dispatch log, its average and slowest run', () => {
    writeHistory('2026-01-02', [outcome('a[0]', 'success'), outcome('a[0]', 'success'), outcome('a[0]', 'failed'), outcome('b[0]', 'dlq')]);
    writeLog('2026-01-02', [dispatch('a[0]', 100), dispatch('a[0]', 301)]);
    const { subscribers } = getBreakdown(configDir, NOW);
    expect(subscribers).toEqual([
      { subscriberId: 'a[0]', delivered: 2, failedAttempts: 1, givenUp: 0, avgMs: 201, maxMs: 301 },
      { subscriberId: 'b[0]', delivered: 0, failedAttempts: 0, givenUp: 1, avgMs: null, maxMs: null },
    ]);
  });

  it(`keeps the ${TOP_SUBSCRIBERS} busiest subscribers`, () => {
    writeHistory('2026-01-02', Array.from({ length: TOP_SUBSCRIBERS + 2 }, (_, i) => outcome(`s${String(i).padStart(2, '0')}[0]`, 'success')));
    expect(getBreakdown(configDir, NOW).subscribers).toHaveLength(TOP_SUBSCRIBERS);
  });

  it('counts over the window it is given: an event 30 hours old is in a 3-day breakdown, not in the default 24 hours', () => {
    writeHistory('2026-01-02', [trigger('onRecent'), trigger('onOld', NOW - 30 * HOUR)]);
    expect(getBreakdown(configDir, NOW).topEvents).toEqual([{ event: 'onRecent', count: 1 }]);
    expect(getBreakdown(configDir, NOW, 72 * HOUR).topEvents).toEqual([{ event: 'onOld', count: 1 }, { event: 'onRecent', count: 1 }]);
  });

  it('is empty when nothing was recorded, whether the folders are empty or missing', () => {
    expect(getBreakdown(configDir, NOW)).toEqual({ topEvents: [], otherEvents: 0, otherText: '', subscribers: [] });
    expect(getBreakdown(join(configDir, 'nowhere'), NOW)).toEqual({ topEvents: [], otherEvents: 0, otherText: '', subscribers: [] });
  });
});
