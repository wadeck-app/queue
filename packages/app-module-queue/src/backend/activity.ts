import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';

export interface QueueActivity {
  last5Min: number;
  last60Min: number;
  last24Hours: number;
}

export interface ActivityPoint {
  /** Start of the slice on the local clock, HH:MM. */
  label: string;
  events: number;
}

export interface ActivitySeries {
  /** The last hour in 5-minute slices, oldest first; the last slice is the current, partial one. */
  lastHour: ActivityPoint[];
  /** The last 24 hours in one-hour slices, oldest first; the last slice is the current, partial one. */
  lastDay: ActivityPoint[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How many events were pushed in the last 5 minutes, 60 minutes and 24 hours: a trend, where `getStatus` is a snapshot. */
export function getActivity(configDir: string, nowMs: number = Date.now()): QueueActivity {
  const [last5Min, last60Min, last24Hours] = new HistoryReader(join(configDir, 'history')).countTriggers(nowMs, [
    5 * MINUTE_MS,
    60 * MINUTE_MS,
    24 * HOUR_MS,
  ]);
  return { last5Min: last5Min!, last60Min: last60Min!, last24Hours: last24Hours! };
}

function timeLabel(atMs: number): string {
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toPoints(startMs: number, bucketMs: number, counts: number[]): ActivityPoint[] {
  return counts.map((events, i) => ({ label: timeLabel(startMs + i * bucketMs), events }));
}

/** Events pushed per time slice, for the dashboard charts: the same trigger records as {@link getActivity}, grouped. */
export function getActivitySeries(configDir: string, nowMs: number = Date.now()): ActivitySeries {
  const reader = new HistoryReader(join(configDir, 'history'));
  const hour = reader.bucketTriggers(nowMs, 5 * MINUTE_MS, 12);
  const day = reader.bucketTriggers(nowMs, HOUR_MS, 24);
  return {
    lastHour: toPoints(hour.startMs, 5 * MINUTE_MS, hour.counts),
    lastDay: toPoints(day.startMs, HOUR_MS, day.counts),
  };
}
