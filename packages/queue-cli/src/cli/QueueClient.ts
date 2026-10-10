import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { QueueCommands } from '@wadeck-app/queue-core';

export function createQueueClient(configDir: string): DaemonClient<QueueCommands> {
  return createDaemonClient<QueueCommands>({ configDir, commands: {} as QueueCommands });
}
