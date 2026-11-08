// Entry point for the relay client's background process, spawned by
// `queue relay start` the same way daemon-entry.ts is spawned for the main
// queue daemon (see queue-cli/src/cli/QueueIndex.ts).
import { join } from 'node:path';
import { startRelayDaemon } from './RelayDaemon.js';
import { createRelayLogger } from './RelayLogger.js';
import { installLastResortHandlers } from './lastResort.js';
import { relayStateDir } from './relayClient.js';

const configDir = process.env.QUEUE_CONFIG_DIR;
if (!configDir) {
  console.error('[queue-relay-client] QUEUE_CONFIG_DIR must be set.');
  process.exit(1);
}

// Installed first: whatever fails from here on is written to relay.log with its cause instead of killing the process silently
const crashLog = createRelayLogger(join(relayStateDir(configDir), 'relay.log'));
installLastResortHandlers({
  proc: process,
  log: (line) => {
    crashLog(line);
    console.error(line);
  },
  exit: process.exit,
});

void startRelayDaemon(configDir);
