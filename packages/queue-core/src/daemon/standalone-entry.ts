// Entry point for spawning the queue daemon as a bare detached process, with
// no dependency on queue-cli's bundle layout. Used by queue-relay-client to
// wake the daemon on demand (see guiding-principles.md: QueueDaemon self-
// terminates after 60s idle, so a separate always-on process can't assume
// it's already running).
import { startDaemon } from './QueueDaemon.js';

const configDir = process.env.QUEUE_CONFIG_DIR;
if (!configDir) {
  console.error('[queue-core] QUEUE_CONFIG_DIR must be set to start the daemon standalone.');
  process.exit(1);
}

void startDaemon(configDir);
