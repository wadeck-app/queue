import type { HistoryEntry } from '@wadeck-app/queue-core';
import { WORKFLOW_RUN_EVENT } from './ciWait.js';

/** One delivery of the relay's own webhook history (`GET /api/webhook-history`), the part a wait uses. */
export interface RelayDelivery {
  receivedAt: string;
  source: string;
  eventType: string;
  deliveryId: string;
  verified: boolean;
  payload?: Record<string, unknown> | null;
}

/** How many of the latest workflow_run deliveries are read from the relay's history. */
export const RELAY_HISTORY_LIMIT = 100;

/**
 * The verified workflow_run deliveries of the relay as history entries, in memory only: nothing is pushed into the queue, so no subscriber runs a second time.
 * They answer what the relay client could not see: a delivery that came while it was not connected (an on-demand client takes about 10 s to connect, GitHub
 * delivers `requested` about 3 s after the push) is never replayed to it, but the relay keeps it.
 */
export function entriesOfRelayDeliveries(deliveries: RelayDelivery[]): HistoryEntry[] {
  return deliveries
    .filter((delivery) => delivery.source === 'github' && delivery.eventType === 'workflow_run' && delivery.verified && delivery.payload)
    .map((delivery) => ({
      ts: delivery.receivedAt,
      eventId: `relay-${delivery.deliveryId}`,
      event: WORKFLOW_RUN_EVENT,
      subscribers: [],
      orphan: false,
      payload: delivery.payload,
    }));
}

/** What `queue wait ci` needs of the relay's HTTP API: the deliveries it holds, newest first. */
export interface RelayHistoryApi {
  /** Across midnight: what was received at or after `since`, the day before included when it reaches there. */
  listDeliveriesSince(query: { limit: number; eventType: string; source: string; verified: boolean; includePayload: boolean; since: string; repo?: string }): Promise<RelayDelivery[]>;
}

/**
 * The latest verified GitHub workflow_run deliveries held by the relay as history entries, only those received at or after `sinceMs` (the commit's own time: nothing about it can
 * have been delivered before). The time is also sent as `since` so a relay that supports it sends less; one that does not sends its latest ones and the filter here applies.
 * A relay that cannot be read throws, with the reason.
 */
export async function readRelayHistoryEntries(api: RelayHistoryApi, sinceMs: number, repo?: string): Promise<HistoryEntry[]> {
  const deliveries = await api.listDeliveriesSince({ limit: RELAY_HISTORY_LIMIT, eventType: 'workflow_run', source: 'github', verified: true, includePayload: true, since: new Date(sinceMs).toISOString(), ...(repo !== undefined && { repo }) });
  return entriesOfRelayDeliveries(deliveries).filter((entry) => Date.parse(entry.ts) >= sinceMs);
}
