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
): ApiHistoryPage {
  // Convert page to offset if page is provided
  let finalPagination = { limit: pagination.limit, offset: pagination.offset };
  if (pagination.page !== undefined) {
    const effectiveLimit = pagination.limit ?? DEFAULT_HISTORY_LIMIT;
    finalPagination.offset = pagination.page * effectiveLimit;
  }

  const reader = new HistoryReader(join(configDir, 'history'));
  const page = reader.readPage(filter, finalPagination);
  return { ...page, entries: page.entries.map(withPayloadText) };
}

/** Cap on the payload text sent to the dashboard; the full payload stays available via GET /history/<eventId>. */
export const MAX_PAYLOAD_TEXT_CHARS = 20_000;

export type ApiHistoryEntry = HistoryEntry & { payloadText?: string };
export type ApiHistoryPage = Omit<HistoryPage, 'entries'> & { entries: ApiHistoryEntry[] };

/**
 * The DSL JsonViewer reads `String(row[field])` then JSON.parse, so it needs TEXT, not an object
 * (an object would render as "[object Object]"). `payloadText` is absent -- not empty -- when no
 * payload was recorded, because the DataTable only shows the expand toggle for a truthy field.
 */
function withPayloadText(entry: HistoryEntry): ApiHistoryEntry {
  if (entry.payload === undefined) {
    return entry;
  }
  const text = JSON.stringify(entry.payload, null, 2);
  if (text.length <= MAX_PAYLOAD_TEXT_CHARS) {
    return { ...entry, payloadText: text };
  }
  const marker = `\n... truncated (${MAX_PAYLOAD_TEXT_CHARS} of ${text.length} characters shown). Full payload: GET /history/${entry.eventId}`;
  return { ...entry, payloadText: text.slice(0, MAX_PAYLOAD_TEXT_CHARS) + marker };
}

/** Looks up a single event by its eventId, e.g. to populate a replay confirmation dialog. */
export function getHistoryEntry(configDir: string, eventId: string): HistoryEntry | undefined {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.findByEventId(eventId);
}
