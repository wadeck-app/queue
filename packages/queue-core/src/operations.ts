import { join } from 'node:path';
import { Wal } from './storage/Wal.js';
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

export function listDlqEntries(configDir: string): DlqEntry[] {
  return new DlqStore(join(configDir, 'dlq.ndjson')).readAll();
}

export function clearDlqEntries(configDir: string, id?: string): number {
  return removeFromDlq(new DlqStore(join(configDir, 'dlq.ndjson')), id);
}

export function listQueueSubscribers(configDir: string, req: { event?: string; cwd: string }): ResolvedSubscriber[] {
  return subscribersFor(new ConfigLoader(configDir), req);
}
