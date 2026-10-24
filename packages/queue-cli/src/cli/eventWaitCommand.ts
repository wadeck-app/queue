/**
 * `queue wait <event> [--when <expr>]...`: blocks until a queue event matching the filters is recorded, so an agent
 * can be woken by it instead of polling. Like `queue wait ci` it reads the history (every push is recorded there,
 * even when nobody subscribed), which also answers at once for an event that happened since `--since` before the
 * command started -- no subscribe-before-push race.
 */

import { PayloadFilter, type EventEnvelope, type HistoryEntry } from '@wadeck-app/queue-core';

export const WAIT_EXIT = {
  MATCHED: 0,
  TIMEOUT: 2,
  USAGE: 4,
} as const;

export interface WaitIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export interface EventWaitOptions {
  event: string;
  /** `when:` expressions (same syntax as subscribers); an event must satisfy all of them. */
  whens: string[];
  /** Only events recorded at or after this time (epoch ms) count. */
  sinceMs: number;
  timeoutMs: number;
  pollMs: number;
  json: boolean;
  /** An undeclared event name is refused at once (exit 4) instead of waited for. */
  strict?: boolean;
}

export interface EventWaitDeps {
  /** From the event catalog: when given, the --json result carries `declared` and `suggestions`. */
  declaration?: { declared: boolean; suggestions: string[] };
  /** ISO time that name was last pushed (null: not in the last 7 days), read at the moment of a timeout. */
  lastSeenAt?: () => string | null;
  /** Entries of `options.event` recorded at or after `sinceMs`. */
  readEntries: (sinceMs: number) => HistoryEntry[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  io: WaitIO;
  /** Called once, when the first poll finds no match: nothing to wait for is not worth starting anything for. */
  beforeFirstWait?: () => Promise<void>;
}

function toEnvelope(entry: HistoryEntry): EventEnvelope {
  return {
    id: entry.eventId,
    timestamp: entry.ts,
    event: entry.event,
    payload: entry.payload,
    meta: { cwd: entry.cwd ?? '', projectName: entry.project ?? '' },
  };
}

/** The oldest entry that satisfies every `when`, or null. */
export function findMatch(entries: HistoryEntry[], whens: string[]): HistoryEntry | null {
  const oldestFirst = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const entry of oldestFirst) {
    const envelope = toEnvelope(entry);
    if (whens.every((when) => PayloadFilter.matches(when, envelope))) {
      return entry;
    }
  }
  return null;
}

function describeWait(options: EventWaitOptions): string {
  return options.whens.length === 0 ? options.event : `${options.event} where ${options.whens.join(' and ')}`;
}

export async function eventWaitCommand(options: EventWaitOptions, deps: EventWaitDeps): Promise<number> {
  const { io } = deps;
  const deadline = deps.now() + options.timeoutMs;
  let hookRan = false;
  const declarationFields = deps.declaration === undefined ? {} : { declared: deps.declaration.declared, suggestions: deps.declaration.suggestions };

  for (;;) {
    const match = findMatch(deps.readEntries(options.sinceMs), options.whens);
    if (match) {
      if (options.json) {
        io.stdout.write(JSON.stringify({ matched: true, entry: match, ...declarationFields }) + '\n');
      } else {
        io.stdout.write(`[ok] ${match.event} at ${match.ts} (eventId ${match.eventId})\n`);
        if (match.payload !== undefined) {
          io.stdout.write(`${JSON.stringify(match.payload)}\n`);
        }
      }
      return WAIT_EXIT.MATCHED;
    }

    if (deps.now() >= deadline) {
      const lastSeenAt = deps.lastSeenAt?.();
      if (options.json) {
        io.stdout.write(JSON.stringify({ matched: false, timedOut: true, event: options.event, whens: options.whens, ...declarationFields, ...(lastSeenAt !== undefined && { lastSeenAt }) }) + '\n');
      }
      io.stderr.write(`[timeout] No ${describeWait(options)} was recorded within ${Math.round(options.timeoutMs / 1000)}s.\n`);
      if (lastSeenAt === null) {
        io.stderr.write(`[timeout] "${options.event}" was never seen in the last 7 days: check the name (a typo or a rename?) or that its producer runs.\n`);
      } else if (lastSeenAt !== undefined) {
        io.stderr.write(`[timeout] "${options.event}" was last seen at ${lastSeenAt}: the name exists, the producer is slow or stopped.\n`);
      }
      return WAIT_EXIT.TIMEOUT;
    }
    if (!hookRan) {
      hookRan = true;
      await deps.beforeFirstWait?.();
    }
    await deps.sleep(options.pollMs);
  }
}
