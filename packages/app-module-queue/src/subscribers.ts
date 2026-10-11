import { createQueueAppClient } from './client.js';
import type { ResolvedSubscriber } from '@wadeck-app/queue-core';
import { DaemonUnreachableError } from './errors.js';

/** Lists resolved subscribers (optionally filtered to one event) as configured in subscribers.yml for `cwd`. Read-only: editing stays a `queue sub` CLI operation to avoid a second source of truth. */
export async function listSubscribers(configDir: string, cwd: string, event?: string): Promise<ResolvedSubscriber[]> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start`');
  }
  const response = await client.send('list-subscribers', { event, cwd });
  return response.subscribers;
}
