import { PayloadFilter, getErrorMessage } from '@wadeck-app/queue-core';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { FOLLOW_POLL_INTERVAL_MS } from '@wadeck-app/shared-cli/FollowSnapshot';
import type { EventWaitOptions } from './eventWaitCommand.js';

export const EVENT_WAIT_FLAGS_WITH_VALUE = new Set(['--when', '--since', '--timeout']);
export const EVENT_WAIT_KNOWN_FLAGS = ['--when', '--since', '--timeout', '--json', '--strict', '--help', '-h'];

const DEFAULT_TIMEOUT = '15m';

export type EventWaitArgs = { ok: true; options: EventWaitOptions } | { ok: false; message: string };

function valuesOf(args: string[], flag: string): string[] | { missing: true } {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) {
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { missing: true };
    }
    values.push(value);
  }
  return values;
}

/** `--since`: a duration counted back from now ("10m"), or an absolute time ("2026-10-18T11:00:00Z"). */
function parseSince(raw: string, nowMs: number): number | null {
  try {
    return nowMs - parseDuration(raw);
  } catch {
    const absolute = Date.parse(raw);
    return Number.isNaN(absolute) ? null : absolute;
  }
}

/** `args` is everything after `queue wait`: the event name, then flags. */
export function parseEventWaitArgs(args: string[], nowMs: number): EventWaitArgs {
  const event = args.find((arg, i) => !arg.startsWith('-') && !EVENT_WAIT_FLAGS_WITH_VALUE.has(args[i - 1] ?? ''));
  if (!event) {
    return { ok: false, message: 'No event name given. Usage: queue wait <event> [--when <expr>]... [--since <duration|time>] [--timeout <duration>] [--json] [--strict]' };
  }

  const collected: Record<string, string[]> = {};
  for (const flag of EVENT_WAIT_FLAGS_WITH_VALUE) {
    const values = valuesOf(args, flag);
    if ('missing' in values) {
      return { ok: false, message: `${flag} needs a value.` };
    }
    collected[flag] = values;
  }

  const whens = collected['--when']!;
  for (const when of whens) {
    const problem = PayloadFilter.validate(when);
    if (problem) {
      return { ok: false, message: `--when: ${problem}` };
    }
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(collected['--timeout']![0] ?? DEFAULT_TIMEOUT);
  } catch (err) {
    return { ok: false, message: `${getErrorMessage(err)} (durations look like 30s, 15m, 1h).` };
  }

  const rawSince = collected['--since']![0];
  let sinceMs = nowMs;
  if (rawSince !== undefined) {
    const parsed = parseSince(rawSince, nowMs);
    if (parsed === null) {
      return { ok: false, message: `--since "${rawSince}" is neither a duration (10m, 2h) nor a time (2026-10-18T11:00:00Z).` };
    }
    sinceMs = parsed;
  }

  return { ok: true, options: { event, whens, sinceMs, timeoutMs, pollMs: FOLLOW_POLL_INTERVAL_MS, json: args.includes('--json'), ...(args.includes('--strict') && { strict: true }) } };
}
