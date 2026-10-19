import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActivity, getActivitySeries } from './activity.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-01-02T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-activity-'));
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeDay(date: string, atMs: number[]): void {
  const lines = atMs.map((ms, i) => JSON.stringify({ ts: new Date(ms).toISOString(), type: 'trigger', eventId: `${date}-${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0 }));
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), lines.join('\n') + '\n');
}

describe('getActivity', () => {
  it('counts the events pushed in the last 5 minutes, 60 minutes and 24 hours', () => {
    writeDay('2026-01-02', [NOW - MINUTE, NOW - 10 * MINUTE, NOW - 3 * HOUR]);
    writeDay('2026-01-01', [NOW - 23 * HOUR, NOW - 30 * HOUR]);
    expect(getActivity(configDir, NOW)).toEqual({ last5Min: 1, last60Min: 2, last24Hours: 4 });
  });

  it('is all zeros when nothing was recorded, whether the history folder is empty or missing', () => {
    expect(getActivity(configDir, NOW)).toEqual({ last5Min: 0, last60Min: 0, last24Hours: 0 });
    expect(getActivity(join(configDir, 'nowhere'), NOW)).toEqual({ last5Min: 0, last60Min: 0, last24Hours: 0 });
  });

  it('uses the current time by default', () => {
    writeDay(new Date().toISOString().slice(0, 10), [Date.now() - 1000]);
    expect(getActivity(configDir)).toEqual({ last5Min: 1, last60Min: 1, last24Hours: 1 });
  });
});

describe('getActivitySeries', () => {
  const total = (points: { events: number }[]) => points.reduce((sum, p) => sum + p.events, 0);

  it('gives 12 five-minute slices for the last hour and 24 one-hour slices for the last day, oldest first', () => {
    const series = getActivitySeries(configDir, NOW);
    expect(series.lastHour).toHaveLength(12);
    expect(series.lastDay).toHaveLength(24);
    for (const point of [...series.lastHour, ...series.lastDay]) {
      expect(point.label).toMatch(/^\d{2}:\d{2}$/);
      expect(point.events).toBe(0);
    }
  });

  it('counts each event once in its slice; the newest event lands in the last slice', () => {
    // mid-slice on any local clock: a test instant on a slice boundary would put "30 s ago" in the previous slice
    const midSlice = NOW + 150_000;
    writeDay('2026-01-02', [midSlice - 30_000, midSlice - 2 * HOUR, midSlice - 40 * MINUTE]);
    writeDay('2026-01-01', [midSlice - 23 * HOUR]);
    const series = getActivitySeries(configDir, midSlice);
    expect(series.lastHour.at(-1)?.events).toBe(1);
    expect(total(series.lastHour)).toBe(2);
    expect(series.lastDay.at(-1)?.events).toBe(1);
    expect(total(series.lastDay)).toBe(4);
  });

  it('labels the slices in order on the local clock, one hour apart for the day', () => {
    const { lastDay } = getActivitySeries(configDir, NOW);
    const hours = lastDay.map((p) => Number(p.label.slice(0, 2)));
    hours.slice(1).forEach((hour, i) => expect(hour).toBe((hours[i]! + 1) % 24));
  });

  it('is zeros for a missing history folder', () => {
    expect(total(getActivitySeries(join(configDir, 'nowhere'), NOW).lastDay)).toBe(0);
  });
});
