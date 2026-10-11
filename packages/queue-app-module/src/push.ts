import { createQueueAppClient } from './client.js';
import type { PushResponse } from '@wadeck-app/queue-core';
import { DaemonUnreachableError } from './errors.js';

/** Pushes a one-off event, mirroring `queue push <event> <payload>`. For manual testing from the dashboard, not a delivery-guaranteed API. */
export async function pushEvent(configDir: string, event: string, payload: unknown, opts: { cwd?: string; timeout?: number } = {}): Promise<PushResponse> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start`');
  }
  return client.send('push', { event, payload, cwd: opts.cwd ?? process.cwd(), timeout: opts.timeout });
}
