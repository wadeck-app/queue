import { join } from 'node:path';
import { Wal } from './storage/Wal.js';
import type { WalEntry } from './storage/Wal.js';
import { DlqStore } from './storage/DlqStore.js';
import type { DlqEntry, DlqAppendResult } from './storage/DlqStore.js';
import { ConfigLoader, type ProjectConfigSource } from './ConfigLoader.js';
import { ProjectResolver } from './project/ProjectResolver.js';
import type { ResolvedSubscriber } from './types.js';
import type { StorageDiagnosticSink } from './storage/StorageDiagnostics.js';

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

/** `projectId`: count only the entries recorded for that project (meta.projectId); without it, all of them. */
export function countQueue(wal: Wal, dlq: DlqStore, projectId?: string): QueueCounts {
  if (projectId === undefined) {
    return { pendingCount: wal.pendingCount(), dlqCount: dlq.readAll().length };
  }
  return {
    pendingCount: wal.readAll().filter((entry) => entry.status === 'pending' && entry.meta.projectId === projectId).length,
    dlqCount: dlq.readAll().filter((entry) => entry.meta.projectId === projectId).length,
  };
}

/** Subscribers for one event, or all of them. An invalid subscribers.yml throws: an empty list would hide the mistake. */
export function subscribersFor(configLoader: ConfigLoader, req: { event?: string; cwd?: string; project?: ProjectConfigSource }): ResolvedSubscriber[] {
  if (req.event) {
    return configLoader.getSubscribers(req.event, req.cwd, req.project);
  }
  return Array.from(configLoader.load(req.cwd, req.project).values()).flat();
}

/** Removes one DLQ entry, or all of them when `id` is omitted (`undefined`; an empty id throws); returns how many were removed. The WAL entries that carried their payload go too (see {@link removeDlqEntries}). */
export function removeFromDlq(dlq: DlqStore, wal: Wal, id?: string): number {
  return removeDlqEntries(dlq, wal, id).length;
}

/**
 * Same removal as {@link removeFromDlq}, returning the entries removed (read under the lock of the removal itself). A row that leaves the DLQ for good keeps nothing
 * behind: the WAL entry of the same id, in status `dlq`, held the payload (secrets included) and would stay for ever, so it is removed. A WAL entry in any other
 * status is left alone: it is a replay of that row running under the same id.
 */
export function removeDlqEntries(dlq: DlqStore, wal: Wal, id?: string): DlqEntry[] {
  // Absent id = everything, on purpose; an empty one is a caller bug (a missing value) and must not wipe the DLQ
  if (id !== undefined && (typeof id !== 'string' || id === '')) {
    throw new Error(`An empty DLQ entry id is invalid (got ${JSON.stringify(id)}): nothing was removed. Fix: pass the id shown by 'queue dlq list', or omit the id to clear the whole DLQ.`);
  }
  const removed = id !== undefined ? dlq.removeEntries(id) : dlq.clearEntries();
  purgeWalOfDlqRows(wal, removed);
  return removed;
}

/** Removes the WAL entries (status `dlq` only) of rows that left the DLQ for good: cleared or pushed out at the cap. */
export function purgeWalOfDlqRows(wal: Wal, rows: readonly Pick<DlqEntry, 'id'>[]): void {
  if (rows.length === 0) {
    return;
  }
  const ids = new Set(rows.map((row) => row.id));
  wal.removeWhere((entry) => entry.status === 'dlq' && ids.has(entry.id));
}

export function readQueueCounts(configDir: string, projectId?: string): QueueCounts {
  return countQueue(new Wal(join(configDir, 'wal.ndjson')), new DlqStore(join(configDir, 'dlq.ndjson')), projectId);
}

/** The events still on their way: written to the WAL and neither delivered (acked) nor given up (dlq). Oldest first. */
export function listInFlightEntries(configDir: string): WalEntry[] {
  return new Wal(join(configDir, 'wal.ndjson')).readAll().filter((entry) => entry.status === 'pending' || entry.status === 'failed');
}

export type AbandonResult = { status: 'moved' } | { status: 'not-found' } | { status: 'not-in-flight' };

/** What an out-of-band change of the DLQ did: the entries that ENTERED the queue (a row that already existed is not new) and the entries the 1000-entry cap pushed out. */
export interface DlqChanges {
  added: DlqEntry[];
  evicted: DlqEntry[];
}

export type AbandonDetailed = { status: 'moved'; changes: DlqChanges } | { status: 'not-found' } | { status: 'not-in-flight' };

export interface AbandonOptions {
  /**
   * Write the new row marked `announce: 'pending'` (reason `given-up`): the caller is the daemon, which emits queue.dlq.added right after and clears the mark.
   * A crash in between leaves the mark, and the daemon emits at its next start. Without it the row carries no mark (a process that is not the daemon cannot emit).
   */
  markAnnouncePending?: boolean;
}

/**
 * Gives up an event that is still in flight (pending or failed) by moving it to the DLQ, where it can be replayed or cleared. For the
 * entries nobody will retry any more: a retry is an orchestrator job, and when scheduling it failed or was lost the entry waits forever.
 * Nothing is deleted. Needs no daemon; the locks of the WAL and the DLQ make it safe next to a running one.
 * Writes the files only: nothing is announced. The daemon's `give-up` RPC uses {@link abandonInFlightEntryDetailed} and emits the events itself.
 */
export function abandonInFlightEntry(configDir: string, id: string, now: Date = new Date()): AbandonResult {
  const result = abandonInFlightEntryDetailed(configDir, id, now);
  return result.status === 'moved' ? { status: 'moved' } : result;
}

const isInFlight = (entry: WalEntry): boolean => entry.status === 'pending' || entry.status === 'failed';

/**
 * Same move as {@link abandonInFlightEntry}, also returning what entered the DLQ and what the cap pushed out of it.
 * The WAL status is claimed first with a compare-and-set under the WAL lock (only from pending or failed), and the DLQ row is built from the entry as that lock read it:
 * a delivery acknowledged a moment earlier is refused as not in flight, instead of ending both acked and replayable from the DLQ (a double delivery). If the DLQ write
 * fails the status goes back to what it was.
 */
export function abandonInFlightEntryDetailed(configDir: string, id: string, now: Date = new Date(), options: AbandonOptions = {}): AbandonDetailed {
  const wal = new Wal(join(configDir, 'wal.ndjson'));
  const claim = wal.updateEntryIf(id, isInFlight, { status: 'dlq' });
  if (claim.status === 'not-found') {
    return { status: 'not-found' };
  }
  if (claim.status === 'rejected') {
    return { status: 'not-in-flight' };
  }
  const entry = claim.before;
  const row: DlqEntry = {
    id: entry.id,
    event: entry.event,
    payload: entry.payload,
    meta: entry.meta,
    subscriberId: entry.subscriberId,
    attempts: entry.attempts,
    lastError: entry.lastError !== undefined ? `${entry.lastError} (given up by hand)` : 'given up by hand before any attempt',
    movedAt: now.toISOString(),
    ...(options.markAnnouncePending === true && { announce: 'pending' as const, announceInfo: { reason: 'given-up' as const } }),
  };
  let appended: DlqAppendResult;
  try {
    appended = new DlqStore(join(configDir, 'dlq.ndjson')).append(row);
  } catch (err) {
    // The row was not written: the entry must stay retryable, not sit in status dlq with no row
    wal.updateEntryIf(entry.id, (current) => current.status === 'dlq', { status: entry.status });
    throw err;
  }
  if (appended.evicted !== undefined) {
    purgeWalOfDlqRows(wal, [appended.evicted]);
  }
  return { status: 'moved', changes: { added: appended.inserted ? [row] : [], evicted: appended.evicted !== undefined ? [appended.evicted] : [] } };
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

/** Moves every in-flight event older than the limit to the DLQ (see {@link abandonInFlightEntry}); returns how many. Announces nothing. */
export function abandonStuckEntries(configDir: string, options: { now?: Date; olderThanMs?: number } = {}): { moved: number } {
  return { moved: abandonStuckEntriesDetailed(configDir, options).moved };
}

/** Same as {@link abandonStuckEntries}, also returning what entered the DLQ and what the cap pushed out of it. */
export function abandonStuckEntriesDetailed(configDir: string, options: { now?: Date; olderThanMs?: number } & AbandonOptions = {}): { moved: number; changes: DlqChanges } {
  const changes: DlqChanges = { added: [], evicted: [] };
  let moved = 0;
  for (const entry of stuckEntries(configDir, options)) {
    const result = abandonInFlightEntryDetailed(configDir, entry.id, options.now, options);
    if (result.status === 'moved') {
      moved++;
      changes.added.push(...result.changes.added);
      changes.evicted.push(...result.changes.evicted);
    }
  }
  return { moved, changes };
}

/** A WAL entry in status `dlq` whose DLQ row is gone is kept this long (a give-up may be writing its row), then {@link pruneOrphanedDlqWalEntries} removes it. */
export const ORPHAN_DLQ_WAL_RETENTION_MS = 24 * 3_600_000;

/**
 * Removes the WAL entries in status `dlq` that no DLQ row refers to and that are older than a day: what is left of rows cleared or evicted before the WAL was purged with them
 * (their payload, secrets included, would otherwise stay for ever and every WAL write would rewrite it). Bounded by age so the claim of a give-up in progress is not hit.
 */
export function pruneOrphanedDlqWalEntries(configDir: string, options: { now?: Date; olderThanMs?: number; onDiagnostic?: StorageDiagnosticSink } = {}): { pruned: number } {
  const limit = (options.now ?? new Date()).getTime() - (options.olderThanMs ?? ORPHAN_DLQ_WAL_RETENTION_MS);
  const sink = options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic };
  const wal = new Wal(join(configDir, 'wal.ndjson'), sink);
  const rowIds = new Set(new DlqStore(join(configDir, 'dlq.ndjson'), undefined, sink).readAll().map((row) => row.id));
  const removed = wal.removeWhere((entry) => entry.status === 'dlq' && !rowIds.has(entry.id) && Date.parse(entry.timestamp) < limit);
  return { pruned: removed.length };
}

export function listDlqEntries(configDir: string): DlqEntry[] {
  return new DlqStore(join(configDir, 'dlq.ndjson')).readAll();
}

export function clearDlqEntries(configDir: string, id?: string): number {
  return removeFromDlq(new DlqStore(join(configDir, 'dlq.ndjson')), new Wal(join(configDir, 'wal.ndjson')), id);
}

/** Same as {@link clearDlqEntries}, returning the entries removed instead of their count. */
export function clearDlqEntriesReturning(configDir: string, id?: string): DlqEntry[] {
  return removeDlqEntries(new DlqStore(join(configDir, 'dlq.ndjson')), new Wal(join(configDir, 'wal.ndjson')), id);
}

/** `registryDir`: the project registry that says which project `cwd` is in, hence where its subscribers are kept. */
export function listQueueSubscribers(configDir: string, req: { event?: string; cwd: string; registryDir: string }): ResolvedSubscriber[] {
  const { source } = new ProjectResolver(req.registryDir).resolve(req.cwd);
  return subscribersFor(new ConfigLoader(configDir), { cwd: req.cwd, ...(req.event !== undefined && { event: req.event }), ...(source !== undefined && { project: source }) });
}
