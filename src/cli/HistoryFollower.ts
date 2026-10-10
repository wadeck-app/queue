import type { HistoryEntry } from './HistoryReader.js';

/**
 * Diffs a fresh `HistoryReader.read()` result against a prior snapshot for `queue history --follow`.
 * An entry can grow after it first appears (async subscriber outcomes land later than the trigger),
 * so "changed" means new OR mutated, not just new -- a plain id-presence check would miss updates.
 */
export function diffNewEntries(
  previous: Map<string, string>,
  current: HistoryEntry[],
): { changed: HistoryEntry[]; snapshot: Map<string, string> } {
  const snapshot = new Map<string, string>();
  const changed: HistoryEntry[] = [];

  for (const entry of [...current].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const signature = JSON.stringify(entry);
    snapshot.set(entry.eventId, signature);
    if (previous.get(entry.eventId) !== signature) {
      changed.push(entry);
    }
  }

  return { changed, snapshot };
}
