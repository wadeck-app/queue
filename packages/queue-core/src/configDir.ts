import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The queue config dir (WAL, DLQ, history, subscribers.yml): QUEUE_CONFIG_DIR, else
 * $XDG_CONFIG_HOME/queue, else ~/.config/queue. Same convention as @wadeck-app/shared-cli's
 * ConfigDir.get('queue') (queue-cli has a test that keeps the two equal), restated here so that the
 * packages which only read the queue's data (app-module-queue) need no CLI library for a path.
 */
export function getQueueConfigDir(): string {
  const explicit = process.env['QUEUE_CONFIG_DIR'];
  if (explicit) {
    return explicit;
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg ? join(xdg, 'queue') : join(homedir(), '.config', 'queue');
}
