import { listInFlightEntries, abandonInFlightEntry, abandonStuckEntries, countStuckEntries, STUCK_AFTER_MS } from '@wadeck-app/queue-core';
import { NotInFlightError, PendingNotFoundError } from './errors.js';
import { shortId } from './ids.js';

export interface PendingRow {
  id: string;
  /** What the table shows of the id (the full one is its tooltip). */
  idShort: string;
  event: string;
  subscriberId: string;
  status: 'pending' | 'failed';
  /** "failed, 2 attempts": the state and the attempts in one cell, so the table fits a narrow screen. */
  stateText: string;
  attempts: number;
  lastError: string | null;
  /** Markdown for the expanded row: the whole last error and the whole id. */
  detailsText: string;
  queuedAt: string;
}

export interface PendingList {
  entries: PendingRow[];
  /** How many of them failed an attempt and wait for a retry (the status counter only counts the ones never tried). */
  awaitingRetry: number;
  /** How many have been in flight for so long that nobody retries them any more (see STUCK_AFTER_MS). */
  stuckCount: number;
  /** A sentence about them for the page, empty when there are none (the DSL cannot build text from a count). */
  stuckText: string;
}

/** The events still on their way (queue status counts them): what `queue retry --event <id>` can be given. Payloads are not returned. */
export function listPending(configDir: string): PendingList {
  const entries = listInFlightEntries(configDir).map((entry): PendingRow => ({
    id: entry.id,
    idShort: shortId(entry.id),
    event: entry.event,
    subscriberId: entry.subscriberId,
    status: entry.status === 'failed' ? 'failed' : 'pending',
    stateText: `${entry.status === 'failed' ? 'failed' : 'pending'}, ${entry.attempts} ${entry.attempts === 1 ? 'attempt' : 'attempts'}`,
    attempts: entry.attempts,
    lastError: entry.lastError ?? null,
    detailsText: `${entry.lastError === undefined ? '' : `**Last error** \`${entry.lastError}\`\n\n`}**Id** \`${entry.id}\``,
    queuedAt: entry.timestamp,
  }));
  const stuckCount = countStuckEntries(configDir);
  const hours = STUCK_AFTER_MS / 3_600_000;
  const stuckText =
    stuckCount === 0 ? '' : `${stuckCount} ${stuckCount === 1 ? 'event has' : 'events have'} been in flight for more than ${hours} hours: nobody retries ${stuckCount === 1 ? 'it' : 'them'} any more.`;
  return { entries, awaitingRetry: entries.filter((entry) => entry.status === 'failed').length, stuckCount, stuckText };
}

/**
 * Gives up an event nobody will retry any more (a retry is an orchestrator job; when scheduling it failed or was lost, the entry waits
 * forever): it moves to the dead-letter queue, where it can be replayed or cleared. Nothing is deleted; no daemon is needed.
 */
export function giveUpPending(configDir: string, id: string): { status: 'moved' } {
  const result = abandonInFlightEntry(configDir, id);
  if (result.status === 'not-found') {
    throw new PendingNotFoundError(`No pending event with id ${id} (only events still in the WAL can be given up)`);
  }
  if (result.status === 'not-in-flight') {
    throw new NotInFlightError(`Event ${id} is no longer in flight: it was delivered, or it is already in the dead-letter queue`);
  }
  return { status: 'moved' };
}

/** Gives up every stuck event at once (see {@link giveUpPending}); answers how many moved to the dead-letter queue. */
export function giveUpStuck(configDir: string): { moved: number } {
  return abandonStuckEntries(configDir);
}
