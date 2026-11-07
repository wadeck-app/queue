import type { DlqEntry, DlqNotifyRequest } from '@wadeck-app/queue-core';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { createQueueAppClient } from './client.js';

/**
 * The dashboard writes the queue files itself (give-up, clear), so the daemon did not see the change and emitted nothing. After the file operation
 * succeeded, this tells the daemon through the narrow `dlq-notify` RPC (never `push`: the daemon builds the `queue.dlq.*` event itself and the module
 * cannot forge a `queue.*` event). It does NOT start the daemon: a daemon that is not running has no subscribers to run.
 * The operation has succeeded either way; the result is a sentence for the user when the event could not be sent (loud, never silent), `undefined` otherwise.
 */

export interface DlqChangesToAnnounce {
  /** Entries given up by hand: they entered the DLQ. */
  added?: readonly DlqEntry[];
  /** Entries removed by a clear. */
  cleared?: readonly DlqEntry[];
  /** Entries the 1000-entry cap pushed out of the DLQ by an added one. */
  evicted?: readonly DlqEntry[];
}

/** Entries per request: a clear can remove a thousand rows. */
const NOTIFY_CHUNK_SIZE = 200;

/** The daemon builds the event from the facts of the entry; the payload of the failed event is not needed and does not travel. */
function forNotify(entry: DlqEntry): DlqEntry {
  return { ...entry, payload: null };
}

function describeCount(kind: 'added' | 'removed', count: number): string {
  return `queue.dlq.${kind} (${count} ${count === 1 ? 'entry' : 'entries'})`;
}

export async function announceDlqChanges(configDir: string, changes: DlqChangesToAnnounce): Promise<string | undefined> {
  const added = changes.added ?? [];
  const removed = [
    ...(changes.cleared ?? []).map((entry) => ({ entry: forNotify(entry), reason: 'cleared' })),
    ...(changes.evicted ?? []).map((entry) => ({ entry: forNotify(entry), reason: 'evicted' })),
  ];
  if (added.length === 0 && removed.length === 0) {
    return undefined;
  }
  const requests: DlqNotifyRequest[] = [];
  const addedItems = added.map((entry) => ({ entry: forNotify(entry), reason: 'given-up' }));
  for (let i = 0; i < addedItems.length; i += NOTIFY_CHUNK_SIZE) {
    requests.push({ kind: 'added', entries: addedItems.slice(i, i + NOTIFY_CHUNK_SIZE) });
  }
  for (let i = 0; i < removed.length; i += NOTIFY_CHUNK_SIZE) {
    requests.push({ kind: 'removed', entries: removed.slice(i, i + NOTIFY_CHUNK_SIZE) });
  }
  const what = [added.length > 0 && describeCount('added', added.length), removed.length > 0 && describeCount('removed', removed.length)].filter(Boolean).join(' and ');

  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    return `The ${what} event could not be sent because the daemon is not running: no subscriber was told. The dead-letter queue itself is up to date. Start the daemon with \`queue start\` if subscribers of queue.dlq.* must hear about changes made from the dashboard`;
  }
  try {
    for (const request of requests) {
      const response = await client.send('dlq-notify', request);
      if (response.status !== 'ok') {
        return `The ${what} event could not be sent: the daemon refused it (${response.reason ?? 'no reason given'}). The dead-letter queue itself is up to date`;
      }
    }
  } catch (err) {
    return `The ${what} event could not be sent to the daemon (${getErrorMessage(err)}). The dead-letter queue itself is up to date. If the daemon was started before this version, restart it: \`queue stop\`, the next push starts it again`;
  }
  return undefined;
}
