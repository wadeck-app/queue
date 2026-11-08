import { describeWaiting, type PushResponse } from '@wadeck-app/queue-core';

/** The stderr line for a push that did not go through, or null when it did. `action` is how the command names it ("Event", "Replay"). */
export function pushFailure(response: PushResponse, action: 'Event' | 'Replay'): string | null {
  if (response.status === 'aborted') {
    return `[queue] ${action} aborted: ${response.reason ?? 'unknown reason'}`;
  }
  if (response.status === 'rejected') {
    const accepted = response.supported ? ` The daemon accepts clients ${response.supported}.` : '';
    return `[queue] ${action} rejected (nothing was recorded): ${response.reason ?? 'unknown reason'}.${accepted} Update queue-cli so the CLI and the daemon agree.`;
  }
  return null;
}

/** What `queue push` prints for an `on*` event that was queued, and where: stderr for the warning, stdout otherwise. `text` ends with a newline. */
export interface PushMessage {
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * The line for a queued push. Protocol 1.7.0 answers carry `waiterCount` and `waiters` (the `queue wait` processes waiting for the event): a push nobody subscribes to
 * is then only a warning when nobody waits either. An answer without them (a daemon older than 1.7.0, or one that could not look) keeps the text it always had.
 */
export function pushMessage(event: string, response: PushResponse): PushMessage {
  const subscribers = response.subscriberCount ?? 0;
  const waiting = response.waiterCount;
  if (waiting === undefined) {
    return subscribers === 0
      ? { stream: 'stderr', text: `[warn] queued - no subscribers for '${event}'\n` }
      : { stream: 'stdout', text: `[ok] queued (${subscribers} subscriber${subscribers !== 1 ? 's' : ''})\n` };
  }
  if (waiting === 0) {
    return subscribers === 0
      ? { stream: 'stderr', text: `[warn] queued - no subscribers and no one waiting for '${event}'\n` }
      : { stream: 'stdout', text: `[ok] queued (${subscribers} subscriber${subscribers !== 1 ? 's' : ''})\n` };
  }
  return { stream: 'stdout', text: `[ok] queued (${subscribers} subscriber${subscribers !== 1 ? 's' : ''}, ${describeWaiting(waiting, response.waiters)})\n` };
}
