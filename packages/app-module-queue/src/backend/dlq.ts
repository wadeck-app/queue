import { listDlqEntries, clearDlqEntries } from '@wadeck-app/queue-core';
import type { DlqEntry, DlqReplayResponse, DlqClearResponse } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError } from './errors.js';
import { shortId } from './ids.js';

/** Lists dispatches that permanently failed (retries exhausted), awaiting human attention. Reads the DLQ file: no daemon needed. */
export function listDlq(configDir: string, projectId?: string): Array<DlqEntry & { idShort: string }> {
  return listDlqEntries(configDir)
    .filter((entry) => projectId === undefined || entry.meta.projectId === projectId)
    .map((entry) => ({ ...entry, idShort: shortId(entry.id) }));
}

/** Clears one DLQ entry by id, or all entries when `id` is omitted. Edits the DLQ file under its lock: no daemon needed. */
export function clearDlqEntry(configDir: string, id?: string): DlqClearResponse {
  return { cleared: clearDlqEntries(configDir, id) };
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
