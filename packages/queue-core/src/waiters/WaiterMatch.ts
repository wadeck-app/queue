import { EventMatcher } from '../dispatch/EventMatcher.js';
import { PayloadFilter } from '../dispatch/PayloadFilter.js';
import type { HistoryEntry } from '../storage/HistoryReader.js';
import type { EventEnvelope } from '../types.js';

/** What the envelope of a history record is made of: the daemon builds it from the trigger it just wrote, the wait from the entry it reads. */
export type EnvelopeSource = Pick<HistoryEntry, 'eventId' | 'ts' | 'event' | 'payload' | 'cwd' | 'project'>;

/**
 * The envelope the `--when` filters of a wait are matched against: exactly what the history holds (meta is the working directory and the project name only).
 * The wait and the daemon (which counts the waiters of a push) both build it here, so they cannot disagree about a filter.
 */
export function toEnvelope(entry: EnvelopeSource): EventEnvelope {
  return {
    id: entry.eventId,
    timestamp: entry.ts,
    event: entry.event,
    payload: entry.payload,
    meta: { cwd: entry.cwd ?? '', projectName: entry.project ?? '' },
  };
}

/** True when every filter holds on the envelope (no filter: true). A filter that cannot be evaluated does not hold: that is what a wait does with it. */
export function whensHold(whens: readonly string[], envelope: EventEnvelope): boolean {
  return whens.every((when) => PayloadFilter.matches(when, envelope));
}

/** The oldest entry that satisfies every `when`, or null. */
export function findMatch(entries: HistoryEntry[], whens: string[]): HistoryEntry | null {
  const oldestFirst = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const entry of oldestFirst) {
    if (whensHold(whens, toEnvelope(entry))) {
      return entry;
    }
  }
  return null;
}

const EVALUATION_ERROR_PREFIX = 'error evaluating filter';

/** Same as {@link whensHold}, except that a filter that fails to EVALUATE counts as holding: the daemon never hides a waiter it cannot judge. */
function whensHoldOrBroken(whens: readonly string[], envelope: EventEnvelope): boolean {
  return whens.every((when) => {
    const evaluation = PayloadFilter.evaluate(when, envelope);
    return evaluation.matched || (evaluation.reason ?? '').startsWith(EVALUATION_ERROR_PREFIX);
  });
}

/**
 * The counting rule of the daemon: a waiter counts for an event when one of its event patterns matches the name and all its filters hold.
 * It does not look at what the waiter already saw (an `--all` wait counts until it ends), nor at the project (a wait is not scoped by project).
 */
export function waiterCountsFor(waiter: { events: readonly string[]; whens: readonly string[] }, envelope: EventEnvelope): boolean {
  return waiter.events.some((pattern) => EventMatcher.matches(pattern, envelope.event)) && whensHoldOrBroken(waiter.whens, envelope);
}
