import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';
import { InvalidQueryError } from './errors.js';
import { getBreakdown, type EventCount, type SubscriberStats } from './breakdown.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface OverviewRangeSpec {
  /** The value of the `range` query parameter. */
  value: string;
  /** "Last 6 hours", for titles. */
  title: string;
  /** Length of one slice of the charts. */
  sliceMs: number;
  slices: number;
  /** How one slice is called in a sentence ("Per hour"). */
  sliceLabel: string;
}

/** The periods the overview offers; sliceMs * slices is the period. Between 12 and 72 slices keeps every chart readable. */
export const OVERVIEW_RANGES: readonly OverviewRangeSpec[] = [
  { value: '1h', title: 'Last hour', sliceMs: 5 * MINUTE_MS, slices: 12, sliceLabel: '5 minutes' },
  { value: '6h', title: 'Last 6 hours', sliceMs: 15 * MINUTE_MS, slices: 24, sliceLabel: '15 minutes' },
  { value: '24h', title: 'Last 24 hours', sliceMs: HOUR_MS, slices: 24, sliceLabel: 'hour' },
  { value: '3d', title: 'Last 3 days', sliceMs: HOUR_MS, slices: 72, sliceLabel: 'hour' },
  { value: '7d', title: 'Last 7 days', sliceMs: 6 * HOUR_MS, slices: 28, sliceLabel: '6 hours' },
];

export const DEFAULT_OVERVIEW_RANGE = '24h';

export interface OverviewEventPoint {
  label: string;
  events: number;
}

export interface OverviewFailurePoint {
  label: string;
  failedAttempts: number;
  givenUp: number;
}

export interface OverviewRange {
  range: string;
  title: string;
  sliceLabel: string;
  totals: { events: number; delivered: number; failedAttempts: number; givenUp: number };
  /** Whether any attempt failed or was given up in the period: the failures chart has nothing to draw otherwise. */
  hasFailures: boolean;
  /** Events pushed per slice, oldest first; the last slice is the current, partial one. */
  events: OverviewEventPoint[];
  /** Failures per slice, same slices as `events`. */
  failures: OverviewFailurePoint[];
  /** The most pushed events of the period, most frequent first. */
  topEvents: EventCount[];
  /** The busiest subscribers of the period. */
  subscribers: SubscriberStats[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

function sliceLabelAt(atMs: number, withDate: boolean): string {
  const date = new Date(atMs);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time;
}

const sum = (counts: number[]): number => counts.reduce((total, n) => total + n, 0);

/** What the queue did over one of the overview periods, from the history files: totals, events per slice and failures per slice. */
export function getOverviewRange(configDir: string, range: string | undefined, nowMs: number = Date.now()): OverviewRange {
  const wanted = range === undefined || range === '' ? DEFAULT_OVERVIEW_RANGE : range;
  const spec = OVERVIEW_RANGES.find((candidate) => candidate.value === wanted);
  if (spec === undefined) {
    throw new InvalidQueryError(`range must be one of ${OVERVIEW_RANGES.map((candidate) => candidate.value).join(', ')}, got: "${wanted}"`);
  }
  const reader = new HistoryReader(join(configDir, 'history'));
  const withDate = spec.sliceMs * spec.slices > 24 * HOUR_MS;
  const pushed = reader.bucketTriggers(nowMs, spec.sliceMs, spec.slices);
  const outcomes = reader.bucketOutcomes(nowMs, spec.sliceMs, spec.slices);
  const labelAt = (index: number): string => sliceLabelAt(pushed.startMs + index * spec.sliceMs, withDate);
  const breakdown = getBreakdown(configDir, nowMs, spec.sliceMs * spec.slices);
  const totals = {
    events: sum(pushed.counts),
    delivered: sum(outcomes.success),
    failedAttempts: sum(outcomes.failed),
    givenUp: sum(outcomes.dlq),
  };
  return {
    range: spec.value,
    title: spec.title,
    sliceLabel: spec.sliceLabel,
    totals,
    hasFailures: totals.failedAttempts + totals.givenUp > 0,
    events: pushed.counts.map((events, i) => ({ label: labelAt(i), events })),
    failures: outcomes.failed.map((failedAttempts, i) => ({ label: labelAt(i), failedAttempts, givenUp: outcomes.dlq[i]! })),
    topEvents: breakdown.topEvents,
    subscribers: breakdown.subscribers,
  };
}
