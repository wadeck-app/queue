import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';
import { startDaemon } from './QueueDaemon.js';
import { EventLogger } from '../storage/EventLogger.js';
import { getErrorMessage } from '../errors.js';

const configDir = process.env['QUEUE_CONFIG_DIR'] ?? ConfigDir.get('queue');
startDaemon(configDir).catch((err: unknown) => {
  const message = `Failed to start: ${getErrorMessage(err)}`;
  // The daemon is spawned with stdio:'ignore', so stderr alone would lose the startup failure
  try {
    new EventLogger(join(configDir, 'logs')).logDiagnostic({ source: 'daemon-entry', message });
  } catch (logErr: unknown) {
    process.stderr.write(`[queue-daemon] Could not write startup failure to ${configDir}/logs: ${getErrorMessage(logErr)}\n`);
  }
  process.stderr.write(`[queue-daemon] ${message}\n`);
  process.exit(1);
});
