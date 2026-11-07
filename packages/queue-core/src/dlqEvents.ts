import { isReservedEventName } from '@wadeck-app/queue-sdk/protocol';
import type { DlqEntry } from './storage/DlqStore.js';
import type { EventDeclaration } from './catalog/EventCatalog.js';

/**
 * The events the daemon emits about its dead-letter queue: `queue.dlq.added` when an entry enters it, `queue.dlq.removed` when it leaves it.
 * Pure builders: they know nothing about how an event is pushed. An event carries FACTS and a REFERENCE to the base event
 * (`original: { "$eventRef": "<eventId>" }`), never a copy of the base payload; see dispatch/refResolver.ts for how a template follows it.
 */

export const DLQ_ADDED_EVENT = 'queue.dlq.added';
export const DLQ_REMOVED_EVENT = 'queue.dlq.removed';

/** Longest `error` an `added` event carries, in characters (the full text stays in the DLQ entry). */
export const MAX_DLQ_EVENT_ERROR_CHARS = 500;

export type DlqAddedReason = 'retries-exhausted' | 'permanent-failure' | 'invalid-configuration' | 'given-up';
export type DlqRemovedReason = 'replayed' | 'cleared' | 'evicted';

/** What the code that moves an entry to the DLQ knows about the failure, besides the entry itself. */
export interface DlqAddedInfo {
  reason: DlqAddedReason;
  /** Exit code of a cli command that ran to its end. */
  exitCode?: number;
  /** The command, the URL or `action:<name>` that was dispatched. */
  target?: string;
}

/** What a builder returns: the name and the payload of the event to push. */
export interface BuiltDlqEvent {
  event: typeof DLQ_ADDED_EVENT | typeof DLQ_REMOVED_EVENT;
  payload: Record<string, unknown>;
}

/**
 * Decision (documented): no `queue.dlq.*` event about an entry whose base event is itself a `queue.` event. A subscriber that fails on
 * `queue.dlq.added` would otherwise produce another `queue.dlq.added`, and so on; its failure stays visible in the DLQ and in the history.
 */
export function isDlqEventExcluded(entry: Pick<DlqEntry, 'event'>): boolean {
  return isReservedEventName(entry.event);
}

function capError(error: string): string {
  return error.length <= MAX_DLQ_EVENT_ERROR_CHARS ? error : `${error.slice(0, MAX_DLQ_EVENT_ERROR_CHARS - 1)}…`;
}

/** The fields both events carry; `eventId` is absent (and `original` points at nothing) for an entry written before events were tracked by id. */
function commonFacts(entry: DlqEntry): Record<string, unknown> {
  const eventId = entry.meta.eventId;
  return {
    entryId: entry.id,
    ...(eventId !== undefined && { eventId }),
    event: entry.event,
    subscriberId: entry.subscriberId,
    ...(entry.meta.projectId !== undefined && { projectId: entry.meta.projectId }),
  };
}

function eventRef(entry: DlqEntry): { $eventRef: string | null } {
  return { $eventRef: entry.meta.eventId ?? null };
}

export function buildDlqAddedEvent(entry: DlqEntry, info: DlqAddedInfo): BuiltDlqEvent {
  return {
    event: DLQ_ADDED_EVENT,
    payload: {
      ...commonFacts(entry),
      reason: info.reason,
      error: capError(entry.lastError),
      attempts: entry.attempts,
      ...(info.exitCode !== undefined && { exitCode: info.exitCode }),
      ...(info.target !== undefined && { target: info.target }),
      original: eventRef(entry),
    },
  };
}

export function buildDlqRemovedEvent(entry: DlqEntry, reason: DlqRemovedReason): BuiltDlqEvent {
  return {
    event: DLQ_REMOVED_EVENT,
    payload: {
      ...commonFacts(entry),
      reason,
      original: eventRef(entry),
    },
  };
}

/** Runs `task` on every item with at most `limit` running at once; resolves when all are done. `task` must not throw (a throw stops that worker only). */
export async function runBounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** How many `removed` events a clear emits at the same time. */
export const DLQ_EVENT_BATCH_SIZE = 10;

const REF_DESCRIPTION = 'Reference to the base event, never a copy of its payload: { "$eventRef": "<eventId>" } (null for an entry written before events were tracked by id). '
  + 'A cli or action template that walks into it (`{{ payload.original.taskId }}`) reads the base event\'s payload from the history; `queue history --event-id <id>` shows it by hand.';

function ref(): Record<string, unknown> {
  return {
    type: 'object',
    description: REF_DESCRIPTION,
    properties: { $eventRef: { type: ['string', 'null'] } },
    required: ['$eventRef'],
  };
}

const COMMON_PROPERTIES = {
  entryId: { type: 'string', description: 'Id of the dead-letter entry (the WAL id of the failed delivery).' },
  eventId: { type: 'string', description: 'First-push id of the base event; absent for an entry written before events were tracked by id.' },
  event: { type: 'string', description: 'Name of the base event.' },
  subscriberId: { type: 'string', description: 'The subscriber the delivery was for.' },
  projectId: { type: 'string', description: 'Id of the project the delivery belongs to, when it has one.' },
};

/** The catalog declaration of both events (source `queue`), written by the daemon at start. Documentation: nothing checks a pushed payload against it. */
export const DLQ_EVENT_DECLARATIONS: EventDeclaration[] = [
  {
    name: DLQ_ADDED_EVENT,
    description: 'Emitted by the daemon for every delivery that enters the dead-letter queue. A failed emit is retried at the daemon start and after the next successful push. '
      + 'Not announced: a base event named queue.* and a delivery at the hop cap. '
      + 'Carries facts and a reference to the base event ({ "$eventRef": "<eventId>" }), never its payload; {{ payload.original.<field> }} reads the base payload.',
    outcome: 'failure',
    correlationKey: ['payload.entryId'],
    // Documentation of the shape: the daemon alone emits this event, nothing can push the example
    example: {
      entryId: '3f2a9c1e-0000-4000-8000-000000000001',
      eventId: '7d41b0aa-0000-4000-8000-000000000002',
      event: 'onTaskDone',
      subscriberId: 'my-project/notify',
      projectId: 'my-project',
      reason: 'retries-exhausted',
      error: 'exit code 3',
      attempts: 5,
      exitCode: 3,
      target: 'node notify.js',
      original: { $eventRef: '7d41b0aa-0000-4000-8000-000000000002' },
    },
    schema: {
      type: 'object',
      properties: {
        ...COMMON_PROPERTIES,
        reason: { enum: ['retries-exhausted', 'permanent-failure', 'invalid-configuration', 'given-up'] },
        error: { type: 'string', description: `The last error, at most ${MAX_DLQ_EVENT_ERROR_CHARS} characters.` },
        attempts: { type: 'integer' },
        exitCode: { type: 'integer', description: 'Exit code of a cli command that ran to its end.' },
        target: { type: 'string', description: 'The command, URL or action:<name> that was dispatched.' },
        original: ref(),
      },
      required: ['entryId', 'event', 'subscriberId', 'reason', 'error', 'attempts', 'original'],
    },
  },
  {
    name: DLQ_REMOVED_EVENT,
    description: 'Emitted by the daemon for every entry that leaves the dead-letter queue (replayed, cleared or evicted at the cap). If the emit fails it is not retried. '
      + 'Not announced: a base event named queue.* and an entry at the hop cap. Carries facts and a reference to the base event ({ "$eventRef": "<eventId>" }), never its payload. '
      + 'A replay that fails again gives removed then added with the same entryId.',
    outcome: 'info',
    correlationKey: ['payload.entryId'],
    // Documentation of the shape: the daemon alone emits this event, nothing can push the example
    example: {
      entryId: '3f2a9c1e-0000-4000-8000-000000000001',
      eventId: '7d41b0aa-0000-4000-8000-000000000002',
      event: 'onTaskDone',
      subscriberId: 'my-project/notify',
      projectId: 'my-project',
      reason: 'cleared',
      original: { $eventRef: '7d41b0aa-0000-4000-8000-000000000002' },
    },
    schema: {
      type: 'object',
      properties: {
        ...COMMON_PROPERTIES,
        reason: { enum: ['replayed', 'cleared', 'evicted'] },
        original: ref(),
      },
      required: ['entryId', 'event', 'subscriberId', 'reason', 'original'],
    },
  },
];
