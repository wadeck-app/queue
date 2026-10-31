import { listQueueSubscribers } from '@wadeck-app/queue-core';
import type { ResolvedSubscriber } from '@wadeck-app/queue-core';

const MASK = '***';

function maskValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  return record === undefined ? undefined : Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
}

// The settings of an action may hold anything (a token, a recipient, a message): every value is masked, whatever its type or depth
function maskWith(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
}

/**
 * Lists resolved subscribers (optionally filtered to one event) as configured in subscribers.yml for `cwd`.
 * Reads the configuration itself, so it works with the daemon stopped. Read-only: editing stays a `queue sub`
 * CLI operation to avoid a second source of truth. An invalid subscribers.yml throws.
 * The values of `headers`, `env` and the `with` of an action are masked: they hold tokens, and this answer travels over HTTP to a browser.
 */
export type ListedSubscriber = ResolvedSubscriber;

export function listSubscribers(configDir: string, cwd: string, event: string | undefined, registryDir: string): ListedSubscriber[] {
  return listQueueSubscribers(configDir, { cwd, event, registryDir }).map((subscriber) => ({
    ...subscriber,
    ...(subscriber.headers === undefined ? {} : { headers: maskValues(subscriber.headers) }),
    ...(subscriber.env === undefined ? {} : { env: maskValues(subscriber.env) }),
    ...(subscriber.with === undefined ? {} : { with: maskWith(subscriber.with) }),
  }));
}
