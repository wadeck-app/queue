import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';

export interface OutcomeTotals {
  /** Dispatches that ran their subscriber successfully. */
  delivered: number;
  /** Attempts that failed; a retry follows until the retries run out. */
  failedAttempts: number;
  /** Dispatches given up after their last retry (they sit in the DLQ). */
  givenUp: number;
}

export interface OutcomePoint {
  /** Start of the slice on the local clock, HH:MM. */
  label: string;
  failedAttempts: number;
  givenUp: number;
}

export interface QueueOutcomes {
  last24Hours: OutcomeTotals;
  /** Whether any attempt failed or was given up in the last 24 hours: the chart has nothing to draw otherwise. */
  hasFailures: boolean;
  /** The last 24 hours in one-hour slices, oldest first; the last slice is the current, partial one. */
  series: OutcomePoint[];
}

const HOUR_MS = 3_600_000;
const HOURS = 24;

function timeLabel(atMs: number): string {
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const sum = (counts: number[]): number => counts.reduce((total, n) => total + n, 0);

/** How the dispatches of the last 24 hours ended, from the history files (one pass): totals, and failures per hour for a chart. */
export function getOutcomes(configDir: string, nowMs: number = Date.now()): QueueOutcomes {
  const { startMs, success, failed, dlq } = new HistoryReader(join(configDir, 'history')).bucketOutcomes(nowMs, HOUR_MS, HOURS);
  const last24Hours = { delivered: sum(success), failedAttempts: sum(failed), givenUp: sum(dlq) };
  return {
    last24Hours,
    hasFailures: last24Hours.failedAttempts + last24Hours.givenUp > 0,
    series: failed.map((failedAttempts, i) => ({ label: timeLabel(startMs + i * HOUR_MS), failedAttempts, givenUp: dlq[i]! })),
  };
}
