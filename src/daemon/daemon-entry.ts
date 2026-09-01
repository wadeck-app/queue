import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { startDaemon } from './QueueDaemon.js';
import { getErrorMessage } from '../errors.js';

const configDir = process.env['QUEUE_CONFIG_DIR'] ?? ConfigDir.get('queue');
startDaemon(configDir).catch((err: unknown) => {
  process.stderr.write(`[queue-daemon] Failed to start: ${getErrorMessage(err)}\n`);
  process.exit(1);
});
