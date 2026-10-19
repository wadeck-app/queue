import type { RetryResponse } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError } from './errors.js';

/** Re-dispatches a pending event of the WAL (`queue retry --event <id>`). This runs the subscribers again, so it goes through the daemon. */
export async function retryEvent(configDir: string, eventId: string): Promise<RetryResponse> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start`');
  }
  return client.send('retry', { eventId });
}
