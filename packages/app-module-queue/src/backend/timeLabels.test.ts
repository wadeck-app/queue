import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getActivitySeries } from './activity.js';
import { getOutcomes } from './outcomes.js';
import { getOverviewRange } from './overviewRange.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The chart labels are the dashboard user's clock, not UTC. India has a half-hour offset (+05:30, no daylight saving), so a label computed in UTC
// shows :30 where the local clock shows :00, and no machine whose own zone is UTC could tell the two apart.
const ZONE = 'Asia/Kolkata';
// 2026-10-19 12:10 UTC = 17:40 in Kolkata
const NOW_MS = Date.UTC(2026, 9, 19, 12, 10, 0);

let previousZone: string | undefined;
let configDir: string;

beforeAll(() => {
  previousZone = process.env['TZ'];
  process.env['TZ'] = ZONE;
  // Fails loudly when the runtime ignores TZ: every assertion below would then pass or fail for the wrong reason
  const offsetMinutes = -new Date(NOW_MS).getTimezoneOffset();
  if (offsetMinutes !== 330) {
    throw new Error(`TZ=${ZONE} was not applied by this runtime (offset ${offsetMinutes} min, expected 330): the time label tests cannot tell local from UTC`);
  }
  configDir = makeTempDir('app-module-time-labels-');
});

afterAll(() => {
  if (previousZone === undefined) {
    delete process.env['TZ'];
  } else {
    process.env['TZ'] = previousZone;
  }
  removeTempDir(configDir);
});

describe('time labels of the charts are on the local clock', () => {
  it('activity series: 5-minute slices of the last hour and hourly slices of the last day', () => {
    const { lastHour, lastDay } = getActivitySeries(configDir, NOW_MS);
    expect(lastHour[0]!.label).toBe('16:45');
    expect(lastHour.at(-1)!.label).toBe('17:40');
    expect(lastDay[0]!.label).toBe('18:00');
    expect(lastDay.at(-1)!.label).toBe('17:00');
  });

  it('outcomes: hourly slices of the last day', () => {
    const { series } = getOutcomes(configDir, NOW_MS);
    expect(series[0]!.label).toBe('18:00');
    expect(series.at(-1)!.label).toBe('17:00');
  });

  it('overview: time only up to 24 h, date and time beyond', () => {
    expect(getOverviewRange(configDir, '1h', NOW_MS).events.map((p) => p.label).at(-1)).toBe('17:40');
    expect(getOverviewRange(configDir, '24h', NOW_MS).events.map((p) => p.label).at(-1)).toBe('17:00');
    expect(getOverviewRange(configDir, '3d', NOW_MS).events.map((p) => p.label).at(-1)).toBe('10-19 17:00');
  });
});

describe('the date part of a label is the local date too, across a UTC midnight and a UTC month end', () => {
  // 2026-10-31 20:10 UTC = 2026-11-01 01:40 in Kolkata: both the day and the month differ between the two clocks
  const ACROSS_MIDNIGHT_MS = Date.UTC(2026, 9, 31, 20, 10, 0);

  it('overview over 3 days labels the current slice with the local month and day', () => {
    expect(getOverviewRange(configDir, '3d', ACROSS_MIDNIGHT_MS).events.map((p) => p.label).at(-1)).toBe('11-01 01:00');
  });

  it('overview over 24 hours labels the current slice with the local time only', () => {
    expect(getOverviewRange(configDir, '24h', ACROSS_MIDNIGHT_MS).events.map((p) => p.label).at(-1)).toBe('01:00');
  });
});
