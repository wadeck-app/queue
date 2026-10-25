import { listQueueSubscribers } from '@wadeck-app/queue-core';
import type { ResolvedSubscriber } from '@wadeck-app/queue-core';

const MASK = '***';

function maskValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  return record === undefined ? undefined : Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
}

/**
 * Lists resolved subscribers (optionally filtered to one event) as configured in subscribers.yml for `cwd`.
 * Reads the configuration itself, so it works with the daemon stopped. Read-only: editing stays a `queue sub`
 * CLI operation to avoid a second source of truth. An invalid subscribers.yml throws.
 * The values of `headers` and `env` are masked: they hold tokens, and this answer travels over HTTP to a browser.
 */
export type ListedSubscriber = ResolvedSubscriber;

export function listSubscribers(configDir: string, cwd: string, event: string | undefined, registryDir: string): ListedSubscriber[] {
  return listQueueSubscribers(configDir, { cwd, event, registryDir }).map((subscriber) => ({
    ...subscriber,
    ...(subscriber.headers === undefined ? {} : { headers: maskValues(subscriber.headers) }),
    ...(subscriber.env === undefined ? {} : { env: maskValues(subscriber.env) }),
  }));
}
