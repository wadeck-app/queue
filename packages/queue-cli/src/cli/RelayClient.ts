import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { join } from 'node:path';
import type { RelayCommands } from '@wadeck-app/queue-relay-client';

/** The relay daemon uses a configDir subpath so its port-file never collides with the main queue daemon's. */
export function relayStateDir(configDir: string): string {
  return join(configDir, 'relay-daemon');
}

export function createRelayClient(configDir: string): DaemonClient<RelayCommands> {
  return createDaemonClient<RelayCommands>({ configDir: relayStateDir(configDir), commands: {} as RelayCommands });
}
