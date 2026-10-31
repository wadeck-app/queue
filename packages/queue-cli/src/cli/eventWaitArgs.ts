import { PayloadFilter, eventPatternProblem, getErrorMessage } from '@wadeck-app/queue-core';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { FOLLOW_POLL_INTERVAL_MS } from '@wadeck-app/shared-cli/FollowSnapshot';
import type { EventWaitOptions, EventWaitTarget } from './eventWaitCommand.js';

export const EVENT_WAIT_FLAGS_WITH_VALUE = new Set(['--when', '--since', '--timeout']);
export const EVENT_WAIT_KNOWN_FLAGS = ['--when', '--since', '--timeout', '--json', '--strict', '--all', '--any', '--help', '-h'];

/** How long any `queue wait` (an event, the CI of a commit) waits by default. */
export const WAIT_DEFAULT_TIMEOUT = '30m';

const USAGE = 'queue wait <event> [--when <expr>]... [<event> [--when <expr>]...]... [--all] [--since <duration|time>] [--timeout <duration>] [--json] [--strict]';

export type EventWaitArgs = { ok: true; options: EventWaitOptions } | { ok: false; message: string };

/** `--since`: a duration counted back from now ("10m"), or an absolute time ("2026-10-18T11:00:00Z"). */
function parseSince(raw: string, nowMs: number): number | null {
  try {
    return nowMs - parseDuration(raw);
  } catch {
    const absolute = Date.parse(raw);
    return Number.isNaN(absolute) ? null : absolute;
  }
}

/**
 * Why `arg` is not usable as an event name or pattern for `queue wait`, null when it is fine.
 * `**` is a subscribers.yml alias of `>` but `queue wait` only takes `*` and `>`. A name ending with a dot is what an unquoted
 * `dep.>` leaves behind: the shell took `>` as a redirect.
 */
function waitPatternProblem(arg: string): string | null {
  const segments = arg.split('.');
  if (segments.includes('**')) {
    const suggestion = segments.map((segment) => (segment === '**' ? '>' : segment)).join('.');
    return `"${arg}": "**" is not accepted by "queue wait"; use ">" instead: "${suggestion}".`;
  }
  if (arg.endsWith('.')) {
    return `"${arg}" ends with a dot. If you typed an unquoted pattern, the shell took ">" as a redirect (and may have created a file): quote the pattern, e.g. "${arg}>".`;
  }
  return eventPatternProblem(arg);
}

/**
 * `args` is everything after `queue wait`: one or more events, each followed by its own `--when` filters, then the flags that
 * apply to the whole wait. A `--when` belongs to the event written before it.
 */
export function parseEventWaitArgs(args: string[], nowMs: number): EventWaitArgs {
  const targets: EventWaitTarget[] = [];
  const singles: Record<string, string | undefined> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (EVENT_WAIT_FLAGS_WITH_VALUE.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `${arg} needs a value.` };
      }
      i++;
      if (arg === '--when') {
        const current = targets[targets.length - 1];
        if (current === undefined) {
          return { ok: false, message: `--when "${value}" comes before any event: a filter belongs to the event written before it (queue wait <event> --when <expr>).` };
        }
        const problem = PayloadFilter.validate(value);
        if (problem) {
          return { ok: false, message: `--when: ${problem}` };
        }
        current.whens.push(value);
      } else if (singles[arg] === undefined) {
        singles[arg] = value;
      }
    } else if (!arg.startsWith('-')) {
      // A wildcard that is not a whole segment ("dep.pub*") would silently never match: refuse it now
      const patternProblem = waitPatternProblem(arg);
      if (patternProblem !== null) {
        return { ok: false, message: `Invalid event pattern ${patternProblem} Patterns: "*" (one segment), ">" (one or more remaining segments, last position only), e.g. "dep.*", "dep.>"; always double-quote them in the shell.` };
      }
      targets.push({ event: arg, whens: [] });
    }
  }

  if (targets.length === 0) {
    return { ok: false, message: `No event name given. Usage: ${USAGE}` };
  }
  if (args.includes('--all') && args.includes('--any')) {
    return { ok: false, message: '--all and --any exclude each other: --any (the default) ends at the first event that happens, --all waits for every one.' };
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(singles['--timeout'] ?? WAIT_DEFAULT_TIMEOUT);
  } catch (err) {
    return { ok: false, message: `${getErrorMessage(err)} (durations look like 30s, 15m, 1h).` };
  }

  const rawSince = singles['--since'];
  let sinceMs = nowMs;
  if (rawSince !== undefined) {
    const parsed = parseSince(rawSince, nowMs);
    if (parsed === null) {
      return { ok: false, message: `--since "${rawSince}" is neither a duration (10m, 2h) nor a time (2026-10-18T11:00:00Z).` };
    }
    sinceMs = parsed;
  }

  return {
    ok: true,
    options: {
      targets,
      mode: args.includes('--all') ? 'all' : 'any',
      sinceMs,
      timeoutMs,
      pollMs: FOLLOW_POLL_INTERVAL_MS,
      json: args.includes('--json'),
      ...(args.includes('--strict') && { strict: true }),
    },
  };
}
