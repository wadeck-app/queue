import { join } from 'node:path';
import { HistoryReader, readDispatchDurations } from '@wadeck-app/queue-core';

export const TOP_EVENTS = 8;
export const TOP_SUBSCRIBERS = 10;

export interface EventCount {
  event: string;
  count: number;
}

export interface SubscriberStats {
  subscriberId: string;
  delivered: number;
  failedAttempts: number;
  givenUp: number;
  /** Average / slowest run, from the dispatch log; null when the log recorded no duration for this subscriber. */
  avgMs: number | null;
  maxMs: number | null;
}

export interface QueueBreakdown {
  /** The most pushed events of the last 24 hours, most frequent first. */
  topEvents: EventCount[];
  /** Pushes of the events that did not make the top. */
  otherEvents: number;
  /** The busiest subscribers of the last 24 hours (most dispatches first), with how their dispatches ended. */
  subscribers: SubscriberStats[];
}

const DAY_MS = 24 * 3_600_000;

/** Which events are pushed most and how each subscriber fares, over the last 24 hours. */
export function getBreakdown(configDir: string, nowMs: number = Date.now()): QueueBreakdown {
  const history = new HistoryReader(join(configDir, 'history'));
  const byEvent = [...history.countTriggersByEvent(nowMs, DAY_MS)].map(([event, count]) => ({ event, count }));
  byEvent.sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
  const topEvents = byEvent.slice(0, TOP_EVENTS);

  const durations = readDispatchDurations(configDir, nowMs, DAY_MS);
  const subscribers = [...history.countOutcomesBySubscriber(nowMs, DAY_MS)]
    .map(([subscriberId, counts]) => {
      const timing = durations.get(subscriberId);
      return {
        subscriberId,
        delivered: counts.success,
        failedAttempts: counts.failed,
        givenUp: counts.dlq,
        avgMs: timing === undefined ? null : Math.round(timing.totalMs / timing.runs),
        maxMs: timing === undefined ? null : timing.maxMs,
      };
    })
    .sort((a, b) => b.delivered + b.failedAttempts + b.givenUp - (a.delivered + a.failedAttempts + a.givenUp) || a.subscriberId.localeCompare(b.subscriberId))
    .slice(0, TOP_SUBSCRIBERS);

  return { topEvents, otherEvents: byEvent.slice(TOP_EVENTS).reduce((total, e) => total + e.count, 0), subscribers };
}
