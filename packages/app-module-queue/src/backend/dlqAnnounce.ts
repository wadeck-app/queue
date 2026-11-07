import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { QueueCommands } from '@wadeck-app/queue-core';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';

/**
 * Who does an operation that changes the dead-letter queue (give up, clear). The daemon, when it is reachable: it runs the operation itself and emits the
 * `queue.dlq.*` events from the rows it moved or removed, so the module never supplies the data an event is built from (and could not forge one).
 * When the daemon is not reachable the module does the operation on the queue files directly (they are lock-protected, no daemon needed) and the answer says,
 * loudly, that the `queue.dlq.*` event could not be sent. This never starts the daemon: a daemon that is not running has no subscribers to run.
 */

export type DaemonAttempt<T> =
  | { reached: true; value: T }
  /** `notice`: the sentence for the user about the event that could not be sent, built by {@link eventNotSent}. */
  | { reached: false; failure: { kind: 'not-running' } | { kind: 'failed'; message: string } };

/** Runs `request` against the daemon if it answers; reports why it could not otherwise (no exception: the caller falls back to the files and says so). */
export async function tryDaemon<T>(configDir: string, request: (client: DaemonClient<QueueCommands>) => Promise<T>): Promise<DaemonAttempt<T>> {
  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    return { reached: false, failure: { kind: 'not-running' } };
  }
  try {
    return { reached: true, value: await request(client) };
  } catch (err) {
    return { reached: false, failure: { kind: 'failed', message: getErrorMessage(err) } };
  }
}

export function describeCount(kind: 'added' | 'removed', count: number): string {
  return `queue.dlq.${kind} (${count} ${count === 1 ? 'entry' : 'entries'})`;
}

/**
 * The sentence appended to the answer of an operation done on the files because the daemon could not do it. `what` names the events that were not sent,
 * e.g. `queue.dlq.removed (2 entries)`. The queue itself is up to date either way.
 */
export function eventNotSent(what: string, failure: Extract<DaemonAttempt<never>, { reached: false }>['failure']): string {
  if (failure.kind === 'not-running') {
    return `The ${what} event could not be sent because the daemon is not running: no subscriber was told. The dead-letter queue itself is up to date. Start the daemon with \`queue start\` if subscribers of queue.dlq.* must hear about changes made from the dashboard`;
  }
  return `The ${what} event could not be sent: the daemon could not do the operation (${failure.message}), so it was done on the queue files. The dead-letter queue itself is up to date. If the daemon was started before this version, restart it: \`queue stop\`, the next push starts it again`;
}
