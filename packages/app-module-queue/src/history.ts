import { join } from 'node:path';
import { HistoryReader, DEFAULT_HISTORY_LIMIT } from '@wadeck-app/queue-core';
import type { HistoryEntry, HistoryFilter, HistoryPage } from '@wadeck-app/queue-core';

/**
 * Reads one page of event history (newest first), optionally filtered by event/subscriber/
 * status/since. Works even if the daemon is not running -- it reads history/*.ndjson directly.
 * Paginated by default (same limit/offset convention as `queue history`'s CLI flags and
 * flow-cli's history pagination) so a dashboard view never has to render the entire journal.
 *
 * Pagination via page/limit: if page is given, it is converted to offset = page * effectiveLimit
 * where effectiveLimit = limit or DEFAULT_HISTORY_LIMIT if absent. Offset (if given without page)
 * is used directly. Response always uses offset (no page field).
 */
export function listHistory(
  configDir: string,
  filter: HistoryFilter = {},
  pagination: { limit?: number; offset?: number; page?: number } = {},
): HistoryPage {
  // Convert page to offset if page is provided
  let finalPagination = { limit: pagination.limit, offset: pagination.offset };
  if (pagination.page !== undefined) {
    const effectiveLimit = pagination.limit ?? DEFAULT_HISTORY_LIMIT;
    finalPagination.offset = pagination.page * effectiveLimit;
  }

  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.readPage(filter, finalPagination);
}

/** Looks up a single event by its eventId, e.g. to populate a replay confirmation dialog. */
export function getHistoryEntry(configDir: string, eventId: string): HistoryEntry | undefined {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.findByEventId(eventId);
}
