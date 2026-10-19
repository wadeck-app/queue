import { startRelayDaemon, registerBuiltinPlugin } from '@wadeck-app/queue-relay-client';
import githubPlugin from '@wadeck-app/plugin-github';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getErrorMessage } from '@wadeck-app/queue-core';

// Register GitHub plugin as built-in
registerBuiltinPlugin('@wadeck-app/plugin-github', githubPlugin, ['github']);

// Require QUEUE_CONFIG_DIR environment variable
const configDir = process.env.QUEUE_CONFIG_DIR;
if (!configDir) {
  console.error('[relay] QUEUE_CONFIG_DIR must be set.');
  process.exit(1);
}

// Start relay daemon with error handling
startRelayDaemon(configDir)
  .catch((err) => {
    const message = getErrorMessage(err);
    const errorMsg = `[relay] Relay daemon failed to start: ${message}`;
    console.error(errorMsg);

    // Attempt to append to relay.log (best effort)
    try {
      const logDir = join(configDir, 'relay-daemon');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, 'relay.log');
      appendFileSync(logPath, `${new Date().toISOString()} ${errorMsg}\n`, 'utf-8');
    } catch {
      // Silently ignore log write errors
    }

    process.exit(1);
  });
