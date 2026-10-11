import { createQueueAppClient } from './client.js';

export interface QueueStatus {
  daemonRunning: boolean;
  pendingCount: number;
  dlqCount: number;
  uptimeSec?: number;
  pid?: number;
}

/** Daemon health snapshot. Never throws: an unreachable daemon reports `daemonRunning: false` with zero counts, same as `queue status`. */
export async function getStatus(configDir: string): Promise<QueueStatus> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    return { daemonRunning: false, pendingCount: 0, dlqCount: 0 };
  }
  const response = await client.send('status', undefined);
  return {
    daemonRunning: true,
    pendingCount: response.pendingCount,
    dlqCount: response.dlqCount,
    uptimeSec: response.uptimeSec,
    pid: response.pid,
  };
}
