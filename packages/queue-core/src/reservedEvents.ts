import { RESERVED_EVENT_PREFIX, isReservedEventName } from '@wadeck-app/queue-sdk/protocol';

/**
 * The `queue.` event namespace (push protocol 1.5.0) belongs to the queue daemon: it builds those events itself (`queue.dlq.added`, ...) and
 * no external entry may produce one, so a subscriber on `queue.*` can trust that the event comes from the daemon. These messages are
 * shared by every entry that refuses such a name (wire push, `emit` action, register-events, replay).
 */

/** Why an external entry cannot push `event`, undefined when it can. `what` names the entry in the message ("a push", "the 'emit' action"). */
export function reservedEventProblem(event: string, what: string): string | undefined {
  if (!isReservedEventName(event)) {
    return undefined;
  }
  return `the event name '${event}' is in the '${RESERVED_EVENT_PREFIX}' namespace, which is reserved for events the queue daemon emits itself, so ${what} cannot produce it. Fix: choose another name (for example your own prefix such as 'myapp.${event.slice(RESERVED_EVENT_PREFIX.length)}'); subscribe to '${RESERVED_EVENT_PREFIX}>' in subscribers.yml if you want to react to the daemon's events.`;
}

/** Why a past event cannot be replayed (`queue replay`, dashboard), undefined when it can: a `queue.*` event is a record the daemon built, replaying it would forge one. */
export function replayReservedProblem(event: string, eventId: string): string | undefined {
  if (!isReservedEventName(event)) {
    return undefined;
  }
  return `event ${eventId} is '${event}', in the '${RESERVED_EVENT_PREFIX}' namespace reserved for events the queue daemon emits itself: it cannot be replayed (a replay is a new push, and no client may push such an event). Fix: replay the event it is about instead (its eventId is in the payload, 'original' / 'eventId'; see 'queue history --event-id <id>'), or 'queue dlq replay --id <entryId>' for a dead-letter entry.`;
}
