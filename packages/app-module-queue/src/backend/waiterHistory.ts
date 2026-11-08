import { DEFAULT_HISTORY_LIMIT, readWaiterHistory, type WaitRow, type WaitRowOutcome } from '@wadeck-app/queue-core';
import { printable, span, sweepWaiters, warningsOf, whensText, isAnonymous, type WaitersDeps } from './waiters.js';
import type { ParsedWaiterHistoryQuery } from './waitersQuery.js';

/** One wait of the history, as the Waiters page shows it. `to`, `durationMs`, `event` and `eventId` are absent (not empty) when the wait has none. */
export interface WaiterHistoryEntry {
  name: string;
  /** `anonymous` or empty: the text of the badge. */
  anonymousText: string;
  events: string[];
  eventsText: string;
  whens: string[];
  whensText: string;
  label: string;
  contact: 'none' | 'pipe';
  pid: number;
  cwd: string;
  /** ISO: when the wait registered. */
  from: string;
  /** ISO: when it ended (a `lost` wait: its last heartbeat). Absent while waiting and for a lost wait nobody has swept yet. */
  to?: string;
  durationMs?: number;
  /** `5m 3s`; the time so far for a wait still waiting; `unknown` for a lost wait with no end time. */
  durationText: string;
  outcome: WaitRowOutcome;
  /** For `matched`: the event that satisfied the wait (the page links to it in the History page). */
  event?: string;
  eventId?: string;
}

export interface WaiterHistoryPage {
  entries: WaiterHistoryEntry[];
  /** Waits matching the filter, before paging. */
  total: number;
  limit: number;
  offset: number;
  sweptText?: string;
  /** Lines and files that could not be read, one text. Absent when everything was readable. */
  warningText?: string;
}

function entry(wait: WaitRow, nowMs: number): WaiterHistoryEntry {
  const events = wait.events.map(printable);
  const whens = wait.whens.map(printable);
  let durationText: string;
  if (wait.durationMs !== undefined) {
    durationText = span(wait.durationMs);
  } else if (wait.outcome === 'waiting') {
    durationText = span(nowMs - Date.parse(wait.startedAt));
  } else {
    durationText = 'unknown';
  }
  return {
    name: printable(wait.name),
    anonymousText: isAnonymous(wait.name) ? 'anonymous' : '',
    events,
    eventsText: events.join(', '),
    whens,
    whensText: whensText(whens),
    label: printable(wait.label),
    contact: wait.contact.kind,
    pid: wait.pid,
    cwd: printable(wait.cwd),
    from: wait.startedAt,
    ...(wait.endedAt !== undefined && { to: wait.endedAt }),
    ...(wait.durationMs !== undefined && { durationMs: wait.durationMs }),
    durationText,
    outcome: wait.outcome,
    ...(wait.event !== undefined && { event: printable(wait.event) }),
    ...(wait.eventId !== undefined && { eventId: printable(wait.eventId) }),
  };
}

/**
 * The waits that were, newest first: who waited, from when to when, how it ended, read from `waiters/history/<day>.ndjson` (no daemon needed). The waits that are over are
 * swept first (recorded as lost), like `queue waiters --history`. Paged like the History route (`limit`, `offset` or `page`, answered with `total`, `limit`, `offset`).
 */
export function listWaiterHistory(configDir: string, query: ParsedWaiterHistoryQuery, deps: WaitersDeps = {}): WaiterHistoryPage {
  const now = deps.now ?? Date.now;
  const swept = sweepWaiters(configDir, deps);
  const limit = query.pagination.limit ?? DEFAULT_HISTORY_LIMIT;
  const offset = query.pagination.page !== undefined ? query.pagination.page * limit : (query.pagination.offset ?? 0);
  const read = readWaiterHistory(configDir, {
    now,
    ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }),
    ...(deps.fs !== undefined && { fs: deps.fs }),
    ...(query.filter.sinceMs !== undefined && { since: query.filter.sinceMs }),
    ...(query.filter.name !== undefined && { name: query.filter.name }),
    ...(query.filter.outcome !== undefined && { outcome: query.filter.outcome }),
    // The reader keeps the newest `limit`: ask for all of them to count the total, this route slices
    limit: Number.MAX_SAFE_INTEGER,
  });
  const problems = [...read.problems];
  if (read.skippedLines > 0) {
    problems.push(`${read.skippedLines} line${read.skippedLines === 1 ? '' : 's'} of the waits history could not be read (torn or not a record) and ${read.skippedLines === 1 ? 'was' : 'were'} skipped.`);
  }
  const warningText = warningsOf(swept.problems, problems);
  return {
    entries: read.rows.slice(offset, offset + limit).map((wait) => entry(wait, now())),
    total: read.rows.length,
    limit,
    offset,
    ...(swept.sweptText !== undefined && { sweptText: swept.sweptText }),
    ...(warningText !== undefined && { warningText }),
  };
}
