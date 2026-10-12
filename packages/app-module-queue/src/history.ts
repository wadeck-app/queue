import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';
import type { HistoryEntry, HistoryFilter, HistoryPage } from '@wadeck-app/queue-core';

/**
 * Reads one page of event history (newest first), optionally filtered by event/subscriber/
 * status/since. Works even if the daemon is not running -- it reads history/*.ndjson directly.
 * Paginated by default (same limit/offset convention as `queue history`'s CLI flags and
 * flow-cli's history pagination) so a dashboard view never has to render the entire journal.
 */
export function listHistory(
  configDir: string,
  filter: HistoryFilter = {},
  pagination: { limit?: number; offset?: number } = {},
): HistoryPage {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.readPage(filter, pagination);
}

/** Looks up a single event by its eventId, e.g. to populate a replay confirmation dialog. */
export function getHistoryEntry(configDir: string, eventId: string): HistoryEntry | undefined {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.findByEventId(eventId);
}
