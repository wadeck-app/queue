import { createRequire } from 'node:module';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { spawnDetachedProcess } from '@wadeck-app/queue-core';
import type { QueueCommands, PushResponse } from '@wadeck-app/queue-core';

const require = createRequire(import.meta.url);

function createClient(configDir: string) {
  return createDaemonClient<QueueCommands>({ configDir, commands: {} as QueueCommands });
}

/**
 * Wakes the main queue daemon if it has idled itself out (QueueDaemon.ts
 * self-terminates 60s after the WAL is empty, by design -- see
 * guiding-principles.md). The relay client is a separate always-on process
 * and must never assume the daemon is already running.
 */
export async function ensureDaemonRunning(configDir: string): Promise<void> {
  const client = createClient(configDir);
  if (await client.isRunning().catch(() => false)) return;

  const entryPath = require.resolve('@wadeck-app/queue-core/dist/daemon/standalone-entry.js');
  spawnDetachedProcess(entryPath, { QUEUE_CONFIG_DIR: configDir });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await client.isRunning().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('[queue-relay-client] Failed to start the queue daemon within 5s.');
}

export async function pushToQueue(configDir: string, event: string, payload: unknown): Promise<PushResponse> {
  const client = createClient(configDir);
  return client.send('push', { event, payload, cwd: configDir });
}
