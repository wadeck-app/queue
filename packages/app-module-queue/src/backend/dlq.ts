import { listDlqEntries, clearDlqEntriesReturning } from '@wadeck-app/queue-core';
import type { DlqEntry, DlqReplayResponse, DlqClearResponse } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError } from './errors.js';
import { shortId } from './ids.js';
import { announceDlqChanges } from './dlqAnnounce.js';

/** Lists dispatches that permanently failed (retries exhausted), awaiting human attention. Reads the DLQ file: no daemon needed. */
export function listDlq(configDir: string, projectId?: string): Array<DlqEntry & { idShort: string }> {
  return listDlqEntries(configDir)
    .filter((entry) => projectId === undefined || entry.meta.projectId === projectId)
    .map((entry) => ({ ...entry, idShort: shortId(entry.id) }));
}

/**
 * Clears one DLQ entry by id, or all entries when `id` is omitted. Edits the DLQ file under its lock: no daemon needed. Once the file is written, the daemon is told
 * (queue.dlq.removed, reason cleared); when that cannot be done the clear stands and `message` says so (the dashboard shows it instead of its default text).
 */
export async function clearDlqEntry(configDir: string, id?: string): Promise<DlqClearResponse & { message?: string }> {
  const removed = clearDlqEntriesReturning(configDir, id);
  const problem = await announceDlqChanges(configDir, { cleared: removed });
  const done = removed.length === 1 ? 'Entry removed' : `${removed.length} entries removed`;
  return { cleared: removed.length, ...(problem !== undefined && { message: `${done}. ${problem}` }) };
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
