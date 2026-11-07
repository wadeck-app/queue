import type { EventEnvelope } from '../types.js';
import { HISTORY_MAX_AGE_DAYS, HISTORY_MAX_TOTAL_BYTES } from '../storage/LogRetention.js';
import { KEEP_AS_DATA, type ResolveRef } from '../walkPayloadPath.js';

/**
 * Lazy `{ "$eventRef": "<eventId>" }` references in the payload of the events the daemon builds about itself (`queue.dlq.added`,
 * `queue.dlq.removed`): a template placeholder that walks into the reference reads the payload of the referenced (base) event, loaded from the
 * history only when a placeholder needs it. The policy is {@link canResolveRef}, in one place; everything else is plain data.
 */

/** The only events whose `original` reference is followed. */
const REF_EVENTS: ReadonlySet<string> = new Set(['queue.dlq.added', 'queue.dlq.removed']);

/** The one top-level payload key where a reference is followed. */
const REF_KEY_PATH = ['original'] as const;

/**
 * The single policy: a reference is followed only when the envelope was built by the daemon (`meta.origin === 'queue'`, an internal flag that
 * no wire request can set), the event is exactly `queue.dlq.added` or `queue.dlq.removed`, and the reference sits at the top-level key
 * `original`. Anywhere else the object is plain data. A client cannot push a `queue.` event and cannot set `meta.origin`, so a payload it sends
 * never reaches this rule with a true answer.
 */
export function canResolveRef(envelope: Pick<EventEnvelope, 'event' | 'meta'>, walked: readonly string[]): boolean {
  return envelope.meta.origin === 'queue'
    && REF_EVENTS.has(envelope.event)
    && walked.length === REF_KEY_PATH.length
    && walked.every((segment, index) => segment === REF_KEY_PATH[index]);
}

/** The base event a reference points at: only its payload is ever handed to a template (never its metadata, nor the whole trigger). */
export interface ResolvedEvent {
  payload?: unknown;
}

/** Finds the base event by its first-push id, or undefined when the history no longer holds it. May throw when the history cannot be read. */
export type RefLookup = (eventId: string) => ResolvedEvent | undefined;

/**
 * A reference could not be followed. The message names the reference, never a payload value, and says what to do. `permanent` is true when
 * trying again cannot help (the base event is gone); false when the history could not be read right now.
 */
export class EventRefError extends Error {
  readonly refId: string | null;
  readonly permanent: boolean;

  constructor(message: string, refId: string | null, permanent: boolean) {
    super(message);
    this.name = 'EventRefError';
    this.refId = refId;
    this.permanent = permanent;
  }

  /** The same error, with where it was met in front of the message (`payload field 'original.taskId'`, `with.payload.text`). */
  withContext(context: string): EventRefError {
    return new EventRefError(`${context}: ${this.message}`, this.refId, this.permanent);
  }
}

function historyLimits(): string {
  return `the history keeps at most ${HISTORY_MAX_AGE_DAYS} days and ${Math.round(HISTORY_MAX_TOTAL_BYTES / (1024 * 1024))} MB`;
}

function missingMessage(refId: string): string {
  return `the base event ${refId} that this event refers to is no longer in the history (${historyLimits()}, older or larger parts are pruned). ` +
    `Fix: read the data you need from the base event before then, or look it up by hand with 'queue history --event-id ${refId} --json'.`;
}

const NULL_REF_MESSAGE = `this event refers to no base event ({ "$eventRef": null }: the dead-letter entry was written before events were tracked by id, so its base event is unknown). ` +
  `Fix: nothing can be loaded for this entry; use a field that the event carries itself ('event', 'subscriberId', 'reason', 'error').`;

/**
 * Builds the reference resolver of one dispatch. The lookup is injected (the daemon passes the history reader); {@link forEnvelope} gives the
 * `resolveRef` callback of one envelope: it refuses (keeps as data) whatever {@link canResolveRef} refuses, loads a base event lazily on the first
 * placeholder that needs it, and answers the same payload to later placeholders of the same dispatch without looking again.
 */
export class RefResolver {
  constructor(private readonly lookup: RefLookup) {}

  forEnvelope(envelope: Pick<EventEnvelope, 'event' | 'meta'>): ResolveRef {
    const loaded = new Map<string, unknown>();
    return (ref, walked) => {
      if (!canResolveRef(envelope, walked)) {
        return KEEP_AS_DATA;
      }
      if (ref === null) {
        throw new EventRefError(NULL_REF_MESSAGE, null, true);
      }
      if (loaded.has(ref)) {
        return loaded.get(ref);
      }
      let found: ResolvedEvent | undefined;
      try {
        found = this.lookup(ref);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new EventRefError(`the history could not be read to load the base event ${ref} (${reason}). Fix: check the 'history' folder of the queue configuration; the delivery is retried.`, ref, false);
      }
      if (found === undefined) {
        throw new EventRefError(missingMessage(ref), ref, true);
      }
      loaded.set(ref, found.payload);
      return found.payload;
    };
  }
}
