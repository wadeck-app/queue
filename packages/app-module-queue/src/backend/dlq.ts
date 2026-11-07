import { listDlqEntries, clearDlqEntriesReturning } from '@wadeck-app/queue-core';
import type { DlqEntry, DlqReplayResponse, DlqClearResponse } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError } from './errors.js';
import { shortId } from './ids.js';
import { describeCount, eventNotSent, tryDaemon } from './dlqAnnounce.js';

/** Lists dispatches that permanently failed (retries exhausted), awaiting human attention. Reads the DLQ file: no daemon needed. */
export function listDlq(configDir: string, projectId?: string): Array<DlqEntry & { idShort: string }> {
  return listDlqEntries(configDir)
    .filter((entry) => projectId === undefined || entry.meta.projectId === projectId)
    .map((entry) => ({ ...entry, idShort: shortId(entry.id) }));
}

/**
 * Clears one DLQ entry by id, or all entries when `id` is omitted. With the daemon reachable the daemon does it (it removes the rows and emits queue.dlq.removed from what it
 * removed; this module writes nothing). Without it the DLQ file is edited under its lock and `message` says the event could not be sent (the dashboard shows it instead of its default text).
 */
export async function clearDlqEntry(configDir: string, id?: string): Promise<DlqClearResponse & { message?: string }> {
  const attempt = await tryDaemon(configDir, (client) => client.send('dlq-clear', id === undefined ? {} : { id }));
  if (attempt.reached) {
    return { cleared: attempt.value.cleared, ...(attempt.value.reason !== undefined && { reason: attempt.value.reason }) };
  }
  const removed = clearDlqEntriesReturning(configDir, id);
  if (removed.length === 0) {
    return { cleared: 0 };
  }
  const done = removed.length === 1 ? 'Entry removed' : `${removed.length} entries removed`;
  return { cleared: removed.length, message: `${done}. ${eventNotSent(describeCount('removed', removed.length), attempt.failure)}` };
}

/** Re-queues a single DLQ entry for dispatch. This runs the subscriber again, so it goes through the daemon. */
export async function replayDlqEntry(configDir: string, id: string): Promise<DlqReplayResponse> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start`');
  }
  return client.send('dlq-replay', { id });
}
