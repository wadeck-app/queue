import { join } from 'node:path';
import { Wal } from './storage/Wal.js';
import type { WalEntry } from './storage/Wal.js';
import { DlqStore } from './storage/DlqStore.js';
import type { DlqEntry } from './storage/DlqStore.js';
import { ConfigLoader } from './ConfigLoader.js';
import type { ResolvedSubscriber } from './types.js';

/**
 * The queue's reads and its DLQ clearing, written once for every process that works on the queue files:
 * the daemon (through createQueueService) and any process that only needs the data (app-core's queue module).
 * The store-level functions take the stores the caller already holds; the configDir-level ones open them.
 * Nothing here needs the daemon to be running, and the lock in Wal/DlqStore makes concurrent writers safe.
 */

export interface QueueCounts {
  pendingCount: number;
  dlqCount: number;
}

export function countQueue(wal: Wal, dlq: DlqStore): QueueCounts {
  return { pendingCount: wal.pendingCount(), dlqCount: dlq.readAll().length };
}

/** Subscribers for one event, or all of them. An invalid subscribers.yml throws: an empty list would hide the mistake. */
export function subscribersFor(configLoader: ConfigLoader, req: { event?: string; cwd: string }): ResolvedSubscriber[] {
  if (req.event) {
    return configLoader.getSubscribers(req.event, req.cwd);
  }
  return Array.from(configLoader.load(req.cwd).values()).flat();
}

/** Removes one DLQ entry, or all of them when `id` is omitted; returns how many were removed. */
export function removeFromDlq(dlq: DlqStore, id?: string): number {
  return id ? dlq.remove(id) : dlq.clear();
}

export function readQueueCounts(configDir: string): QueueCounts {
  return countQueue(new Wal(join(configDir, 'wal.ndjson')), new DlqStore(join(configDir, 'dlq.ndjson')));
}

/** The events still on their way: written to the WAL and neither delivered (acked) nor given up (dlq). Oldest first. */
export function listInFlightEntries(configDir: string): WalEntry[] {
  return new Wal(join(configDir, 'wal.ndjson')).readAll().filter((entry) => entry.status === 'pending' || entry.status === 'failed');
}

export type AbandonResult = { status: 'moved' } | { status: 'not-found' } | { status: 'not-in-flight' };

/**
 * Gives up an event that is still in flight (pending or failed) by moving it to the DLQ, where it can be replayed or cleared. For the
 * entries nobody will retry any more: a retry is an orchestrator job, and when scheduling it failed or was lost the entry waits forever.
 * Nothing is deleted. Needs no daemon; the locks of the WAL and the DLQ make it safe next to a running one.
 */
export function abandonInFlightEntry(configDir: string, id: string, now: Date = new Date()): AbandonResult {
  const wal = new Wal(join(configDir, 'wal.ndjson'));
  const entry = wal.readAll().find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return { status: 'not-found' };
  }
  if (entry.status !== 'pending' && entry.status !== 'failed') {
    return { status: 'not-in-flight' };
  }
  new DlqStore(join(configDir, 'dlq.ndjson')).append({
    id: entry.id,
    event: entry.event,
    payload: entry.payload,
    meta: entry.meta,
    subscriberId: entry.subscriberId,
    attempts: entry.attempts,
    lastError: entry.lastError !== undefined ? `${entry.lastError} (given up by hand)` : 'given up by hand before any attempt',
    movedAt: now.toISOString(),
  });
  wal.updateEntry(entry.id, { status: 'dlq' });
  return { status: 'moved' };
}

/**
 * How long an event may stay in flight before nobody is considered to be retrying it: a retry follows 1, 2, 4, 8 and 16 minutes after the
 * previous attempt (RetryScheduler), so an entry still pending or failed two hours after it was written lost its retry job.
 */
export const STUCK_AFTER_MS = 2 * 3_600_000;

function stuckEntries(configDir: string, options: { now?: Date; olderThanMs?: number }): WalEntry[] {
  const limit = (options.now ?? new Date()).getTime() - (options.olderThanMs ?? STUCK_AFTER_MS);
  return listInFlightEntries(configDir).filter((entry) => Date.parse(entry.timestamp) < limit);
}

/** How many in-flight events are older than the limit (see {@link STUCK_AFTER_MS}). Moves nothing. */
export function countStuckEntries(configDir: string, options: { now?: Date; olderThanMs?: number } = {}): number {
  return stuckEntries(configDir, options).length;
}

/** Moves every in-flight event older than the limit to the DLQ (see {@link abandonInFlightEntry}); returns how many. */
export function abandonStuckEntries(configDir: string, options: { now?: Date; olderThanMs?: number } = {}): { moved: number } {
  let moved = 0;
  for (const entry of stuckEntries(configDir, options)) {
    if (abandonInFlightEntry(configDir, entry.id, options.now).status === 'moved') {
      moved++;
    }
  }
  return { moved };
}

export function listDlqEntries(configDir: string): DlqEntry[] {
  return new DlqStore(join(configDir, 'dlq.ndjson')).readAll();
}

export function clearDlqEntries(configDir: string, id?: string): number {
  return removeFromDlq(new DlqStore(join(configDir, 'dlq.ndjson')), id);
}

export function listQueueSubscribers(configDir: string, req: { event?: string; cwd: string }): ResolvedSubscriber[] {
  return subscribersFor(new ConfigLoader(configDir), req);
}
