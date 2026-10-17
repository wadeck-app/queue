import type { HistoryEntry } from '@wadeck-app/queue-core';
import { diffSnapshot } from '@wadeck-app/shared-cli/FollowSnapshot';

/**
 * Diffs a fresh `HistoryReader.read()` result against a prior snapshot for `queue history --follow`.
 * An entry can grow after it first appears (async subscriber outcomes land later than the trigger),
 * so "changed" means new OR mutated, not just new -- `diffSnapshot` compares a JSON signature per
 * eventId, which is why this uses it rather than `diffAppendOnlyLog`. Entries are sorted by ts first so
 * the changed ones print in chronological order.
 */
export function diffNewEntries(
  previous: Map<string, string>,
  current: HistoryEntry[],
): { changed: HistoryEntry[]; snapshot: Map<string, string> } {
  const chronological = [...current].sort((a, b) => a.ts.localeCompare(b.ts));
  return diffSnapshot(previous, chronological, (entry) => entry.eventId);
}
