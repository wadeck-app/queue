import { join } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';
import type { HistoryEntry, HistoryFilter } from '@wadeck-app/queue-core';

/** Reads the event history (newest first), optionally filtered by event/subscriber/status/since. Works even if the daemon is not running -- it reads history/*.ndjson directly. */
export function listHistory(configDir: string, filter: HistoryFilter = {}): HistoryEntry[] {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.read(filter);
}

/** Looks up a single event by its eventId, e.g. to populate a replay confirmation dialog. */
export function getHistoryEntry(configDir: string, eventId: string): HistoryEntry | undefined {
  const reader = new HistoryReader(join(configDir, 'history'));
  return reader.findByEventId(eventId);
}
