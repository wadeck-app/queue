import { listQueueSubscribers } from '@wadeck-app/queue-core';
import type { ResolvedSubscriber } from '@wadeck-app/queue-core';

/**
 * Lists resolved subscribers (optionally filtered to one event) as configured in subscribers.yml for `cwd`.
 * Reads the configuration itself, so it works with the daemon stopped. Read-only: editing stays a `queue sub`
 * CLI operation to avoid a second source of truth. An invalid subscribers.yml throws.
 */
export function listSubscribers(configDir: string, cwd: string, event?: string): ResolvedSubscriber[] {
  return listQueueSubscribers(configDir, { cwd, event });
}
