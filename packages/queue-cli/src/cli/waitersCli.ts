/**
 * `queue waiters [--json]`: the `queue wait` processes that are waiting right now. `queue waiters --history [...]`: the waits that were, newest first, from when to when and
 * how each ended. Both read the files under `<configDir>/waiters/` directly (no daemon needed, nothing started).
 * A listing first sweeps the waits that are over (a killed wait leaves a file): each is recorded once as `lost`, and said.
 */

import { WAITER_OUTCOMES, WaiterRegistry, EventMatcher, getErrorMessage, listLiveWaiters, readWaiterHistory, type LiveWaiter, type WaitRowOutcome } from '@wadeck-app/queue-core';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { COMMAND_FLAGS } from './commandFlags.js';
import { scanFlags } from './flagScan.js';
import { liveWaiterView, liveWaitersText, waitHistoryText } from './waitersView.js';

export interface WaitersDeps {
  configDir: string;
  io: { stdout: { write: (text: string) => unknown }; stderr: { write: (text: string) => unknown } };
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export const WAITERS_HELP = `queue waiters - Who is waiting (queue wait), and who waited
Usage:
  queue waiters [--json]
  queue waiters --history [--since <duration>] [--name <glob>] [--outcome <outcome>] [--limit <N>] [--json]

queue waiters: the waits running now ("queue wait <event> --name <who>.<what>", "queue wait ci"): name, what they wait for (events and --when filters),
label (the commit of a CI wait), how the daemon can wake them (polling only), since when, last heartbeat and its process. A wait whose heartbeat is
more than 30 s late is marked (stale); after 60 s, or when its process is gone, it is no longer listed. A wait started without --name is called anon.<pid>.
  --json             An array, one object per wait (name, anonymous, events, whens, label, contact, pid, cwd, since, startedAt, lastSeen, stale)

queue waiters --history: every wait of the last 90 days, newest first, with from, to, duration, outcome and the event that ended it.
  --since <d>        Only the waits that ended within this long (30m, 2h, 7d), and the ones still waiting
  --name <glob>      Only the waits with this name; * stands for any characters (agent.*)
  --outcome <o>      waiting | matched (the event and its id are shown) | timeout | cancelled (SIGINT, SIGTERM, exit) | refused (name taken) | lost (killed: no end was written)
  --limit <N>        The newest N (default 100)
  --json             An array of rows (newest first) with the same fields, plus endedAt, durationMs, outcome, eventId, event

Neither the filters (--when) nor the working directory are secret here and no payload is ever stored. Exit codes: 0 listed | 1 invalid flags, or the folder cannot be read.
`;

const OUTCOMES: readonly string[] = ['waiting', ...WAITER_OUTCOMES];

function fail(deps: WaitersDeps, message: string): number {
  deps.io.stderr.write(`[fail] ${message}\n`);
  return 1;
}

function pathOf(problem: string): string {
  const end = problem.indexOf('.json');
  return end === -1 ? problem : problem.slice(0, end + 5);
}

export async function waitersCommand(args: string[], deps: WaitersDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const spec = COMMAND_FLAGS['waiters']!;
  const scan = scanFlags(args, spec.spec, 'queue waiters', [], 0);
  if (scan.issues.length > 0) {
    return fail(deps, `${scan.issues.map((issue) => issue.message).join('\n[fail] ')}\nUsage: ${spec.usage}`);
  }
  const json = scan.switches.has('--json');
  const history = scan.switches.has('--history');
  const since = scan.values.get('--since')?.[0];
  const name = scan.values.get('--name')?.[0];
  const outcome = scan.values.get('--outcome')?.[0];
  const limit = scan.values.get('--limit')?.[0];

  if (!history) {
    for (const [flag, value] of [['--since', since], ['--name', name], ['--outcome', outcome], ['--limit', limit]] as const) {
      if (value !== undefined) {
        return fail(deps, `${flag} only applies to the history: add --history (queue waiters --history ${flag} ${value}).`);
      }
    }
  }
  let sinceMs: number | undefined;
  if (since !== undefined) {
    try {
      sinceMs = now() - parseDuration(since);
    } catch {
      return fail(deps, `--since "${since}" is not a duration (30m, 2h, 7d).`);
    }
  }
  if (outcome !== undefined && !OUTCOMES.includes(outcome)) {
    return fail(deps, `--outcome must be one of ${OUTCOMES.join(', ')}, got "${outcome}".`);
  }
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit)) {
    return fail(deps, `--limit must be a whole number from 1, got "${limit}".`);
  }

  // The waits that are over are recorded as lost first, so this listing and every later one agree
  let swept: { removed: string[]; problems: string[] };
  try {
    swept = new WaiterRegistry(deps.configDir, { now, ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }), onDiagnostic: (message) => { deps.io.stderr.write(`[warn] ${message}\n`); } }).sweepStale();
  } catch (error) {
    return fail(deps, `cannot read the waiters of ${deps.configDir}: ${getErrorMessage(error)}. Fix: check that the folder is readable and writable by this user.`);
  }
  if (swept.removed.length > 0) {
    deps.io.stderr.write(`[info] ${swept.removed.length} wait${swept.removed.length === 1 ? '' : 's'} that ended without a trace ${swept.removed.length === 1 ? 'was' : 'were'} recorded as lost: ${swept.removed.join(', ')}\n`);
  }
  const reported = new Set(swept.problems.map(pathOf));
  const warn = (problem: string): void => {
    if (!reported.has(pathOf(problem))) {
      deps.io.stderr.write(`[warn] ${problem}\n`);
    }
  };
  swept.problems.forEach((problem) => { deps.io.stderr.write(`[warn] ${problem}\n`); });

  if (history) {
    const read = readWaiterHistory(deps.configDir, {
      now,
      ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }),
      ...(sinceMs !== undefined && { since: sinceMs }),
      ...(name !== undefined && { name }),
      ...(outcome !== undefined && { outcome: outcome as WaitRowOutcome }),
      ...(limit !== undefined && { limit: Number(limit) }),
    });
    read.problems.forEach(warn);
    if (read.skippedLines > 0) {
      deps.io.stderr.write(`[warn] ${read.skippedLines} line${read.skippedLines === 1 ? '' : 's'} of the waits history could not be read (torn or not a record) and ${read.skippedLines === 1 ? 'was' : 'were'} skipped.\n`);
    }
    if (json) {
      deps.io.stdout.write(JSON.stringify(read.rows, null, 2) + '\n');
    } else {
      deps.io.stdout.write(read.rows.length === 0 ? '[ok] no wait recorded\n' : waitHistoryText(read.rows, now()));
    }
    return 0;
  }

  const scanned = listLiveWaiters(deps.configDir, { now, ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }) });
  scanned.problems.forEach(warn);
  const views = scanned.waiters.map((waiter) => liveWaiterView(waiter, now()));
  if (json) {
    deps.io.stdout.write(JSON.stringify(views, null, 2) + '\n');
  } else {
    deps.io.stdout.write(views.length === 0 ? '[ok] no one is waiting\n' : liveWaitersText(views, now()));
  }
  return 0;
}

/**
 * The "Waiting now" section appended to the terminal form of `queue list-subscribers` and `queue sub list`: empty when nobody waits (a list of subscribers stays what it was).
 * `event` narrows it to the waits that wait for that event name. Never throws: a folder that cannot be read is said on stderr and the list goes on without the section.
 */
export function waitingNowSection(configDir: string, event: string | undefined, stderr: { write: (text: string) => unknown }, deps: { now?: () => number; isAlive?: (pid: number) => boolean } = {}): string {
  const now = deps.now ?? Date.now;
  const scanned = listLiveWaiters(configDir, { now, ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }) });
  for (const problem of scanned.problems) {
    stderr.write(`[warn] ${problem}\n`);
  }
  const waiting = scanned.waiters.filter((waiter: LiveWaiter) => event === undefined || waiter.events.some((pattern) => EventMatcher.matches(pattern, event)));
  return waiting.length === 0 ? '' : `\n${liveWaitersText(waiting.map((waiter) => liveWaiterView(waiter, now())), now())}`;
}
