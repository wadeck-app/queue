import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonHandle, ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { join } from 'node:path';
import { RelayConnection } from './RelayConnection.js';

export const RELAY_DAEMON_PORT = 47911;

export interface RelayStatus {
  connected: boolean;
  pid: number;
  uptimeSec: number;
}

export type RelayCommands = {
  status: () => RelayStatus;
};

/**
 * The relay client's own singleton daemon -- separate from QueueDaemon so it
 * can stay connected indefinitely (idleTimeout: null) without fighting the
 * main daemon's intentional 60s idle-shutdown. Uses a configDir subpath
 * ("relay-daemon") so its port-file never collides with the main daemon's,
 * which uses the same top-level QUEUE_CONFIG_DIR.
 */
export async function startRelayDaemon(configDir: string): Promise<DaemonHandle> {
  const relayStateDir = join(configDir, 'relay-daemon');
  const startedAt = Date.now();
  const connection = new RelayConnection({
    configDir,
    onLog: (line) => console.log(line),
  });

  const daemonHandle = await createDaemon<RelayCommands>({
    configDir: relayStateDir,
    port: RELAY_DAEMON_PORT,
    idleTimeout: null,
    commands: {
      status: (): RelayStatus => ({
        connected: connection.isConnected(),
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }),
    },
  });

  void connection.start();

  const shutdown = (reason: ShutdownReason) => {
    connection.stop();
    void daemonHandle.stop(reason).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('signal'));
  process.on('SIGTERM', () => shutdown('signal'));

  return daemonHandle;
}
