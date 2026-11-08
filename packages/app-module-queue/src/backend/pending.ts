import { listInFlightEntries, abandonInFlightEntryDetailed, abandonStuckEntriesDetailed, countStuckEntries, STUCK_AFTER_MS } from '@wadeck-app/queue-core';
import { NotInFlightError, PendingNotFoundError, UnexpectedDaemonAnswerError } from './errors.js';
import { shortId } from './ids.js';
import { describeCount, eventNotSent, tryDaemon } from './dlqAnnounce.js';

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
 * forever): it moves to the dead-letter queue, where it can be replayed or cleared. Nothing is deleted. With the daemon reachable the daemon does the move
 * and emits queue.dlq.added itself (this module writes nothing); without it the move is done on the files and `message` says the event could not be sent.
 */
export async function giveUpPending(configDir: string, id: string): Promise<{ status: 'moved'; message?: string }> {
  const attempt = await tryDaemon(configDir, (client) => client.send('give-up', { id }));
  if (attempt.reached) {
    const response = attempt.value;
    switch (response.status) {
      case 'moved':
        return { status: 'moved' };
      case 'not-found':
        throw new PendingNotFoundError(`No pending event with id ${id} (only events still in the WAL can be given up)`);
      case 'not-in-flight':
        throw new NotInFlightError(`Event ${id} is no longer in flight: it was delivered, or it is already in the dead-letter queue`);
      case 'rejected':
        throw new Error(`The daemon refused to give up event ${JSON.stringify(id)}: ${response.reason ?? 'no reason given'}`);
      default:
        // Not a reason to edit the files behind the back of a daemon that answered: the operation cannot be confirmed
        throw new UnexpectedDaemonAnswerError(`The daemon answered give-up of event ${JSON.stringify(id)} with ${JSON.stringify((response as { status?: unknown }).status ?? null)}, so it cannot be confirmed that the event moved. ${DAEMON_MISMATCH_FIX}`);
    }
  }
  const result = abandonInFlightEntryDetailed(configDir, id);
  if (result.status === 'not-found') {
    throw new PendingNotFoundError(`No pending event with id ${id} (only events still in the WAL can be given up)`);
  }
  if (result.status === 'not-in-flight') {
    throw new NotInFlightError(`Event ${id} is no longer in flight: it was delivered, or it is already in the dead-letter queue`);
  }
  return { status: 'moved', message: `Moved to the dead-letter queue. ${eventNotSent(announcedEvents(result.changes.added.length, result.changes.evicted.length), attempt.failure)}` };
}

const DAEMON_MISMATCH_FIX = "Fix: dashboard and daemon do not agree on the protocol; restart the daemon (queue stop, then the next push starts it again) and check the Pending page.";

function announcedEvents(added: number, evicted: number): string {
  // A move onto a row that already existed adds nothing new to announce: the sentence still has to name what the daemon would have sent
  return [added > 0 && describeCount('added', added), evicted > 0 && describeCount('removed', evicted)].filter(Boolean).join(' and ') || 'queue.dlq.*';
}

/** Gives up every stuck event at once (see {@link giveUpPending}); answers how many moved to the dead-letter queue. */
export async function giveUpStuck(configDir: string): Promise<{ moved: number; message?: string }> {
  const attempt = await tryDaemon(configDir, (client) => client.send('give-up-stuck', {}));
  if (attempt.reached) {
    const moved: unknown = attempt.value.moved;
    if (typeof moved !== 'number' || !Number.isInteger(moved) || moved < 0) {
      throw new UnexpectedDaemonAnswerError(`The daemon answered give-up-stuck without a usable count (${JSON.stringify(moved ?? null)}), so it cannot be confirmed that anything moved. ${DAEMON_MISMATCH_FIX}`);
    }
    return { moved };
  }
  const { moved, changes } = abandonStuckEntriesDetailed(configDir);
  if (moved === 0) {
    return { moved };
  }
  return { moved, message: `${moved} stuck ${moved === 1 ? 'event' : 'events'} moved to the dead-letter queue. ${eventNotSent(announcedEvents(changes.added.length, changes.evicted.length), attempt.failure)}` };
}
