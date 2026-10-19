import { listDlqEntries, clearDlqEntries } from '@wadeck-app/queue-core';
import type { DlqEntry, DlqReplayResponse, DlqClearResponse } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';
import { toChoices, type Choice } from './choices.js';
import { DaemonUnreachableError } from './errors.js';

/** The entries as choices for the replay and clear forms of the dashboard. */
export function dlqOptions(entries: readonly DlqEntry[]): Choice[] {
  return toChoices(entries.map((entry) => ({ id: entry.id, label: `${entry.event} / ${entry.subscriberId} (${entry.id})` })));
}

/** Lists dispatches that permanently failed (retries exhausted), awaiting human attention. Reads the DLQ file: no daemon needed. */
export function listDlq(configDir: string): DlqEntry[] {
  return listDlqEntries(configDir);
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
