import { join } from 'node:path';
import { findProjectIncludingDeleted } from '@wadeck-app/project-sdk';
import { HistoryReader, listDlqEntries, listInFlightEntries } from '@wadeck-app/queue-core';
import type { HistoryEntry } from '@wadeck-app/queue-core';
import { UnknownProjectError } from './errors.js';
import { assertProjectId } from './projects.js';

/** How many history entries the card lists. */
export const RELATED_ITEMS_LIMIT = 10;

/** What the count of the card means: the dispatches that still need attention (in flight, or given up in the dead-letter queue). */
export const RELATED_COUNT_LABEL = 'pending or in the dead-letter queue';

/** How many subscriber ids a subtitle names before it says `+N`. */
const SUBSCRIBER_IDS_SHOWN = 2;

export interface RelatedItem {
  label: string;
  /** Always starts with `/modules/`. */
  url: string;
  subtitle?: string;
}

/** The answer of `GET /related/project/:projectId`, the contract the project module reads. */
export interface RelatedResponse {
  title: 'Queue';
  /** Dispatches filed under the project that are in flight (pending or failed, awaiting a retry) plus the ones in the dead-letter queue. */
  count: number;
  /** What `count` counts, shown by the project module as "{count} {countLabel}" (short, lowercase). */
  countLabel: string;
  items: RelatedItem[];
  moreUrl: string;
}

export type RelatedStatus = 'orphan' | 'dlq' | 'failed' | 'pending' | 'success' | 'filtered' | 'no subscriber';

/**
 * What the Queue module has about one registered project, for the project detail page. Everything is "dispatches filed under the
 * project": the WAL and DLQ `meta.projectId`, the history `projectId` of the push or of a subscriber outcome. With `to-children` a
 * dispatch is filed under the descendant (the emitter sees nothing of it); with `to-parents` it is filed under the emitter.
 *
 * A virtual or soft-deleted project answers like any other (a project without records has `count: 0` and no item). An id that is
 * in no registry throws {@link UnknownProjectError}, a malformed one `InvalidQueryError`, an unreadable registry whatever the
 * registry reader throws.
 */
export function getRelatedForProject(configDir: string, registryDir: string, projectId: string, now: Date = new Date()): RelatedResponse {
  const id = assertProjectId(projectId);
  if (findProjectIncludingDeleted(registryDir, id) === undefined) {
    throw new UnknownProjectError(`No project with id ${id} in the registry (live or deleted); \`project list\` shows the registered ids`);
  }

  const inFlight = listInFlightEntries(configDir).filter((entry) => entry.meta.projectId === id).length;
  const given = listDlqEntries(configDir).filter((entry) => entry.meta.projectId === id).length;

  // Newest first; the event id breaks a tie so that the same files always give the same card
  const entries = new HistoryReader(join(configDir, 'history'))
    .readProject(id)
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.eventId.localeCompare(a.eventId))
    .slice(0, RELATED_ITEMS_LIMIT);

  const projectParam = `project=${encodeURIComponent(id)}`;
  const items: RelatedItem[] = entries.map((entry) => ({
    label: `${entry.event} ${statusOf(entry)}`,
    url: `/modules/queue/history?${projectParam}&event=${encodeURIComponent(entry.event)}`,
    subtitle: subtitleOf(entry, id, now),
  }));
  if (given > 0) {
    items.unshift({
      label: `${given} in the dead-letter queue`,
      url: `/modules/queue/dlq?${projectParam}`,
      subtitle: `count = ${inFlight} in flight + ${given} given up`,
    });
  }
  return { title: 'Queue', count: inFlight + given, countLabel: RELATED_COUNT_LABEL, items, moreUrl: `/modules/queue/history?${projectParam}` };
}

/**
 * Worst outcome wins (dlq, failed), then `pending` when fewer dispatches reported than were matched, then success, then filtered.
 * The outcomes of every project count towards "reported": `matchedCount` covers all the projects the event was dispatched to.
 * A retry has its own history entry with no trigger: it shows as a separate `orphan` row, it is not merged into the original.
 */
export function statusOf(entry: HistoryEntry): RelatedStatus {
  if (entry.orphan) {
    return 'orphan';
  }
  const statuses = new Set(entry.subscribers.map((outcome) => outcome.status));
  if (statuses.has('dlq')) {
    return 'dlq';
  }
  if (statuses.has('failed')) {
    return 'failed';
  }
  const reported = entry.subscribers.filter((outcome) => outcome.status !== 'filtered').length;
  if ((entry.matchedCount ?? 0) > reported) {
    return 'pending';
  }
  if (statuses.has('success')) {
    return 'success';
  }
  return statuses.has('filtered') ? 'filtered' : 'no subscriber';
}

function subtitleOf(entry: HistoryEntry, projectId: string, now: Date): string {
  // The subscribers of this project; an event only filed under it by its push (to-children) names the ones that ran
  const own = entry.subscribers.filter((outcome) => outcome.projectId === projectId);
  const ids = [...new Set((own.length > 0 ? own : entry.subscribers).map((outcome) => outcome.subscriberId))];
  const time = relativeTime(entry.ts, now);
  if (ids.length === 0) {
    return time;
  }
  const shown = ids.slice(0, SUBSCRIBER_IDS_SHOWN).join(', ');
  return `${time} - ${shown}${ids.length > SUBSCRIBER_IDS_SHOWN ? ` +${ids.length - SUBSCRIBER_IDS_SHOWN}` : ''}`;
}

/** "just now", "5 min ago", "3 h ago", then the UTC date; an unparsable time is shown as it was recorded. */
function relativeTime(ts: string, now: Date): string {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) {
    return ts;
  }
  const minutes = Math.floor((now.getTime() - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  if (minutes < 48 * 60) {
    return `${Math.floor(minutes / 60)} h ago`;
  }
  return new Date(at).toISOString().slice(0, 10);
}
