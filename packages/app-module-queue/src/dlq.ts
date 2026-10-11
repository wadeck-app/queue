import { createQueueAppClient } from './client.js';
import type { DlqEntry, DlqReplayResponse, DlqClearResponse } from '@wadeck-app/queue-core';
import { DaemonUnreachableError } from './errors.js';

async function requireRunningClient(configDir: string) {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start`');
  }
  return client;
}

/** Lists dispatches that permanently failed (retries exhausted), awaiting human attention. */
export async function listDlq(configDir: string): Promise<DlqEntry[]> {
  const client = await requireRunningClient(configDir);
  const response = await client.send('dlq-list', undefined);
  return response.entries;
}

/** Re-queues a single DLQ entry for dispatch. */
export async function replayDlqEntry(configDir: string, id: string): Promise<DlqReplayResponse> {
  const client = await requireRunningClient(configDir);
  return client.send('dlq-replay', { id });
}

/** Clears one DLQ entry by id, or all entries when `id` is omitted. */
export async function clearDlqEntry(configDir: string, id?: string): Promise<DlqClearResponse> {
  const client = await requireRunningClient(configDir);
  return client.send('dlq-clear', { id });
}
