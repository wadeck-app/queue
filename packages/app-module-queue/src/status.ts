import { readQueueCounts, type QueueCounts } from '@wadeck-app/queue-core';

/**
 * The queue's counters, read from its files. Nothing about the daemon: the process answering here is app-core,
 * so a pid or an uptime would describe the wrong process, and the counters do not need the daemon to be up.
 */
export type QueueStatus = QueueCounts;

export function getStatus(configDir: string): QueueStatus {
  return readQueueCounts(configDir);
}
