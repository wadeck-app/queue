import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';

export interface QueueActivity {
  last5Min: number;
  last60Min: number;
  last24Hours: number;
}

const MINUTE_MS = 60_000;

/** How many events were pushed in the last 5 minutes, 60 minutes and 24 hours: a trend, where `getStatus` is a snapshot. */
export function getActivity(configDir: string, nowMs: number = Date.now()): QueueActivity {
  const [last5Min, last60Min, last24Hours] = new HistoryReader(join(configDir, 'history')).countTriggers(nowMs, [
    5 * MINUTE_MS,
    60 * MINUTE_MS,
    24 * 60 * MINUTE_MS,
  ]);
  return { last5Min: last5Min!, last60Min: last60Min!, last24Hours: last24Hours! };
}
