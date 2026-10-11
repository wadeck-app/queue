import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';

/** Resolves the same queue config dir the CLI and daemon use, so the dashboard reads/writes the same WAL/DLQ/history. Mirrors queue-cli's getConfigDir(). */
export function getQueueConfigDir(): string {
  return process.env['QUEUE_CONFIG_DIR'] ?? ConfigDir.get('queue');
}
