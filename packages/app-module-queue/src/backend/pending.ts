import { listInFlightEntries } from '@wadeck-app/queue-core';
import { toChoices, type Choice } from './choices.js';

export interface PendingRow {
  id: string;
  event: string;
  subscriberId: string;
  status: 'pending' | 'failed';
  attempts: number;
  lastError: string | null;
  queuedAt: string;
}

export interface PendingList {
  entries: PendingRow[];
  /** How many of them failed an attempt and wait for a retry (the status counter only counts the ones never tried). */
  awaitingRetry: number;
  /** The entries as the choices of the retry form. */
  options: Choice[];
}

/** The events still on their way (queue status counts them): what `queue retry --event <id>` can be given. Payloads are not returned. */
export function listPending(configDir: string): PendingList {
  const entries = listInFlightEntries(configDir).map((entry): PendingRow => ({
    id: entry.id,
    event: entry.event,
    subscriberId: entry.subscriberId,
    status: entry.status === 'failed' ? 'failed' : 'pending',
    attempts: entry.attempts,
    lastError: entry.lastError ?? null,
    queuedAt: entry.timestamp,
  }));
  return { entries, awaitingRetry: entries.filter((entry) => entry.status === 'failed').length, options: toChoices(entries.map((entry) => ({ id: entry.id, label: `${entry.event} / ${entry.subscriberId} (${entry.id})` }))) };
}
