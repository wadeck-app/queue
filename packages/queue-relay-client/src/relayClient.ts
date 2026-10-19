import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { join } from 'node:path';
import type { RelayCommands } from './RelayDaemon.js';

/** The relay daemon uses a configDir subpath so its port-file never collides with the main queue daemon's. */
export function relayStateDir(configDir: string): string {
  return join(configDir, 'relay-daemon');
}

/** A client for the relay daemon of that queue config dir; ask `isRunning()` first, the relay starts on demand. */
export function createRelayClient(configDir: string): DaemonClient<RelayCommands> {
  return createDaemonClient<RelayCommands>({ configDir: relayStateDir(configDir), commands: {} as RelayCommands });
}
