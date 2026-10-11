// Entry point for the relay client's background process, spawned by
// `queue relay start` the same way daemon-entry.ts is spawned for the main
// queue daemon (see queue-cli/src/cli/QueueIndex.ts).
import { startRelayDaemon } from './RelayDaemon.js';

const configDir = process.env.QUEUE_CONFIG_DIR;
if (!configDir) {
  console.error('[queue-relay-client] QUEUE_CONFIG_DIR must be set.');
  process.exit(1);
}

void startRelayDaemon(configDir);
