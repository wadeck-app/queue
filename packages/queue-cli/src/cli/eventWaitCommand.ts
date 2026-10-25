/**
 * `queue wait <event> [--when <expr>]... [<event> [--when <expr>]...]...`: blocks until a queue event matching the filters is
 * recorded, so an agent can be woken by it instead of polling. Several events (each with its own filters) can be waited for at
 * once: the first one that happens ends the wait (any, the default), or the wait ends when every one has happened (--all).
 * Like `queue wait ci` it reads the history (every push is recorded there, even when nobody subscribed), which also answers at
 * once for an event that happened since `--since` before the command started -- no subscribe-before-push race.
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

/** One thing to wait for: an event and the filters it must satisfy. */
export interface EventWaitTarget {
  event: string;
  /** `when:` expressions (same syntax as subscribers); an event must satisfy all of them. */
  whens: string[];
}

export interface EventWaitOptions {
  /** At least one. */
  targets: EventWaitTarget[];
  /** any: the first target that happens ends the wait. all: the wait ends when every target has happened. */
  mode: 'any' | 'all';
  /** Only events recorded at or after this time (epoch ms) count. */
  sinceMs: number;
  timeoutMs: number;
  pollMs: number;
  json: boolean;
  /** An undeclared event name is refused at once (exit 4) instead of waited for. */
  strict?: boolean;
}

export interface EventWaitDeps {
  /** From the event catalog, by event name: when given, the --json result carries `declared` and `suggestions`. */
  declaration?: Record<string, { declared: boolean; suggestions: string[] }>;
  /** ISO time that name was last pushed (null: not in the last 7 days), read at the moment of a timeout. */
  lastSeenAt?: (event: string) => string | null;
  /** Entries of `event` recorded at or after `sinceMs`. */
  readEntries: (event: string, sinceMs: number) => HistoryEntry[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  io: WaitIO;
  /** Called once, when the first poll finds nothing to end the wait: nothing to wait for is not worth starting anything for. */
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

function describeTarget(target: EventWaitTarget): string {
  return target.whens.length === 0 ? target.event : `${target.event} where ${target.whens.join(' and ')}`;
}

function declarationFieldsOf(deps: EventWaitDeps, event: string): { declared?: boolean; suggestions?: string[] } {
  const declaration = deps.declaration?.[event];
  return declaration === undefined ? {} : { declared: declaration.declared, suggestions: declaration.suggestions };
}

function writeMatch(io: WaitIO, entry: HistoryEntry, label: string): void {
  io.stdout.write(`[ok] ${label}${entry.event} at ${entry.ts} (eventId ${entry.eventId})\n`);
  if (entry.payload !== undefined) {
    io.stdout.write(`${JSON.stringify(entry.payload)}\n`);
  }
}

export async function eventWaitCommand(options: EventWaitOptions, deps: EventWaitDeps): Promise<number> {
  const { io } = deps;
  const { targets } = options;
  const several = targets.length > 1;
  const deadline = deps.now() + options.timeoutMs;
  let hookRan = false;
  const matches: Array<HistoryEntry | null> = targets.map(() => null);

  for (;;) {
    targets.forEach((target, i) => {
      if (matches[i] === null) {
        matches[i] = findMatch(deps.readEntries(target.event, options.sinceMs), target.whens);
      }
    });

    if (options.mode === 'any') {
      // The oldest of the matches found by this poll: when several waits are already satisfied, the first that happened wins
      let first = -1;
      matches.forEach((match, i) => {
        if (match !== null && (first === -1 || match.ts < matches[first]!.ts)) {
          first = i;
        }
      });
      if (first !== -1) {
        const entry = matches[first]!;
        if (options.json) {
          io.stdout.write(JSON.stringify({ matched: true, entry, ...(several && { target: first }), ...declarationFieldsOf(deps, entry.event) }) + '\n');
        } else {
          writeMatch(io, entry, '');
          if (several) {
            io.stderr.write(`[info] wait ${first + 1} of ${targets.length} matched: ${describeTarget(targets[first]!)}\n`);
          }
        }
        return WAIT_EXIT.MATCHED;
      }
    } else if (matches.every((match) => match !== null)) {
      if (options.json) {
        io.stdout.write(JSON.stringify({ matched: true, mode: 'all', entries: matches.map((entry, target) => ({ target, entry })) }) + '\n');
      } else {
        matches.forEach((entry, i) => writeMatch(io, entry!, `${i + 1}/${targets.length} `));
      }
      return WAIT_EXIT.MATCHED;
    }

    if (deps.now() >= deadline) {
      const seconds = Math.round(options.timeoutMs / 1000);
      const open = targets.map((target, i) => ({ target, i })).filter(({ i }) => matches[i] === null);
      if (options.json) {
        const lastSeen = (event: string): { lastSeenAt?: string | null } => {
          const at = deps.lastSeenAt?.(event);
          return at === undefined ? {} : { lastSeenAt: at };
        };
        // One target: the shape agents already read (event, whens at the top). Several: the same fields for each in `targets`.
        const first = targets[0]!;
        const body = several
          ? {
              matched: false,
              timedOut: true,
              mode: options.mode,
              targets: targets.map((target, i) => ({ event: target.event, whens: target.whens, matched: matches[i] !== null, ...declarationFieldsOf(deps, target.event), ...(matches[i] === null && lastSeen(target.event)) })),
            }
          : { matched: false, timedOut: true, event: first.event, whens: first.whens, ...declarationFieldsOf(deps, first.event), ...lastSeen(first.event) };
        io.stdout.write(JSON.stringify(body) + '\n');
      }
      if (options.mode === 'all' && several) {
        io.stderr.write(`[timeout] ${targets.length - open.length} of ${targets.length} waits were satisfied within ${seconds}s; still waiting for: ${open.map(({ target }) => describeTarget(target)).join('; ')}.\n`);
      } else {
        io.stderr.write(`[timeout] No ${open.map(({ target }) => describeTarget(target)).join(' and no ')} was recorded within ${seconds}s.\n`);
      }
      for (const { target } of open) {
        const lastSeenAt = deps.lastSeenAt?.(target.event);
        if (lastSeenAt === null) {
          io.stderr.write(`[timeout] "${target.event}" was never seen in the last 7 days: check the name (a typo or a rename?) or that its producer runs.\n`);
        } else if (lastSeenAt !== undefined) {
          io.stderr.write(`[timeout] "${target.event}" was last seen at ${lastSeenAt}: the name exists, the producer is slow or stopped.\n`);
        }
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
