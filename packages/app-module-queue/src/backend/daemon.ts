import { createQueueAppClient } from './client.js';

export interface DaemonState {
  running: boolean;
  /** What to tell the user when the daemon is down (null when it runs): replay and retry go through the daemon. */
  hint: string | null;
}

export const DAEMON_DOWN_HINT = 'The daemon is not running: replaying and retrying will fail. Start it with `queue start`.';

/** Whether the daemon answers. The queue files are read without it; only the operations that run subscribers need it. */
export async function getDaemonState(configDir: string): Promise<DaemonState> {
  const running = await createQueueAppClient(configDir).isRunning().catch(() => false);
  return { running, hint: running ? null : DAEMON_DOWN_HINT };
}
