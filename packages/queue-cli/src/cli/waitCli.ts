/** Argument parsing and wiring of `queue wait ci` (the decision logic lives in ciWait.ts / ciWaitCommand.ts). */

import { parseCiWaitArgs } from './ciWaitArgs.js';
import { join as pathJoin } from 'node:path';
import { EventMatcher, HistoryReader, getErrorMessage, isEventPattern, type HistoryEntry } from '@wadeck-app/queue-core';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { createRelayClient, relayStateDir } from '@wadeck-app/queue-relay-client/dist/relayClient.js';
import { CI_EXIT } from './ciWait.js';
import { ciWaitCommand, parseGithubRepo, type CiWaitCommandOptions } from './ciWaitCommand.js';
import { createGitPort, inspectRepository, type GitPort } from './ciGit.js';
import { eventWaitCommand, type EventWaitTarget } from './eventWaitCommand.js';
import { anonymousNameWarning, anonymousWaitName, ciOutcomeOf, defaultWaitSessionDeps, eventOutcomeOf, runRegisteredWait, type WaitSessionDeps } from './waitSession.js';
import { RelayOnDemand, isRelayPattern, isRelaySourcedEvent, targetNeedsRelay } from './relayOnDemand.js';
import { checkDeclaration, lastSeenAtOf, lastSeenEventOf, patternMatchesKnownEvent, patternWarning, refuseUndeclared, undeclaredWarning, type DeclarationCheck } from './eventWaitCatalog.js';
import { parseEventWaitArgs, parseSince, WAIT_DEFAULT_TIMEOUT } from './eventWaitArgs.js';

/** How far back `queue wait ci` reads the relayed history when --since is not given. */
const CI_DEFAULT_LOOKBACK_MS = 24 * 3600_000;

export const WAIT_HELP = `queue wait - Block until something happens, so an agent does not have to poll
Usage:
  queue wait <event> [--when <expr>]... [<event> [--when <expr>]...]... [--all] [--since <duration|time>] [--timeout <duration>] [--name <who>.<what>] [--json] [--strict]
  queue wait ci [<sha>] [--repo <owner/name>] [--workflow <name>]... [--since <duration|time>] [--timeout <duration>] [--settle <duration>] [--name <who>.<what>] [--no-infer] [--json]

queue wait <event>: blocks until a queue event of that name (or matching that pattern) is recorded (any "queue push" is, even with no subscriber).
  --when <expr>      Keep only events whose payload satisfies the expression, same syntax as a subscriber's when:
                     "payload.taskId=abc" or a JSONPath such as "$.payload.newStatus". Repeatable: all must hold
  --since <d|time>   Count events recorded since then: a duration back from now (10m, 2h) or a time (2026-10-18T11:00:00Z).
                     Default: only events recorded after the command started
  --timeout <d>      Give up after this long (default 30m)
  --name <who>.<what>  Who waits, for what: "queue push" says "1 waiting: <name>" instead of warning that nobody listens, and
                     "queue waiters" lists it. Lower case, at least one dot, [a-z0-9][a-z0-9._-]*, at most 64 characters, e.g.
                     w-agent-wake.ab12cd34. Each concurrent wait needs its own name (a second live wait with the same name exits 4):
                     put the awaited thing in it. Without --name the wait is called anon.<pid> and warns once; a name will become mandatory
  --all              With several events: wait until every one has happened. Default (--any): the first one ends the wait
  --json             Machine-readable result on stdout ({"matched":true,"entry":{...}} or {"matched":false,"timedOut":true,...}),
                     plus "declared" (is the name in the event catalog), "suggestions" (nearest declared names) and, on a
                     timeout, "lastSeenAt" (last push of that name in the last 7 days, null = none: a typo or a rename,
                     as opposed to a slow producer)
  --strict           An event name that no program declared exits 4 at once, with the nearest declared names. Without it the
                     wait goes on (old and undeclared producers exist) and warns on stderr with the same suggestions.
                     A pattern is never refused (its names may come later)
  A name can be a pattern, same syntax as subscribers.yml: "*" is exactly one segment, ">" is one or more remaining segments (last
  position only). "dep.published.*" matches "dep.published.api" but not "dep.published" or "dep.published.a.b"; "dep.>" matches
  "dep.a" and "dep.a.b" but not "dep"; a bare ">" is every event. "**" is not a wildcard (use ">"). A pattern matches names added later too.
  ALWAYS double-quote it: unquoted, * is globbed and > is a shell redirect that writes a file. A pattern with no known match warns on
  stderr ("queue events list --match "<pattern>"" shows the names). With --all each pattern is satisfied by any one matching name.
  In --json a pattern has no "declared" / "suggestions"; a timeout adds "lastSeenEvent". The result's "event" is the concrete name that
  matched. A wildcard inside a segment ("dep.pub*") exits 4.
  Example: queue wait "dep.published.*" --timeout 1h
  Example: queue wait onStatusChange --when "payload.taskId=abc" --when "payload.newStatus=done" --since 5m
  Several events at once: write them one after the other; a --when belongs to the event written before it, so each event has its own
  filters. The first that happens ends the wait and says which one ("target" in --json, the position of the wait):
    queue wait onTaskDone --when "payload.taskId=abc" onTaskFailed --when "payload.taskId=abc" --timeout 1h
  With --all the result is every match ({"matched":true,"mode":"all","entries":[{"target":0,"entry":{...}},...]}), and a timeout lists
  the waits that were not satisfied.
  It answers at once when a matching event was recorded since --since, so there is no race with the thing you waited for.
  Find the names, the payload paths for --when and a ready command with "queue events list" and "queue events show <name>".
  Exit codes: 0 matched | 2 timeout | 4 invalid usage (including an unknown option: --timout exits 4 and suggests --timeout) / --strict on an undeclared name. "ci" is reserved for the command below.

queue wait ci: blocks until the GitHub CI of a commit is done (events relayed as on.github.workflow_run).
  <sha>              Commit to wait for (full or >= 7 chars); default: HEAD of the current git repository
  --repo <o/n>       Repository; default: the GitHub repository of the "origin" remote
  --workflow <name>  Exact workflow name that must complete (repeatable). Without it, the workflows are inferred from
                     .github/workflows (push trigger, branch and path filters); when that is undecidable, "done" means every run
                     seen for the commit is completed and nothing new happened for --settle
  --since <d|time>   How far back the relayed history is read for a run of the commit: a duration back from now (3d) or a time.
                     Default 24h: for an older commit pass a value that reaches back past its push, or "no run seen" (exit 3) is reported
  --timeout <d>      Give up after this long (default 30m)
  --settle <d>       Quiet window before concluding with no --workflow (default 20s)
  --name <who>.<what>  Same as for an event: how this wait is listed ("queue waiters") and counted by "queue push"
  --no-infer         Do not read git: no push check, no workflow inference
  --json             Machine-readable result on stdout

The relay client: "queue wait ci", and a wait for an event named on.<source>.<type> (on.github.workflow_run) or for a pattern
starting with "on." (on.github.*), need it. A bare ">" does not start it.
If it is not running and the history holds nothing yet, the wait starts it (relay.yml must exist, see "queue relay --help")
and the relay stops by itself 30s after the last such wait ended. A relay started with "queue relay start" is never stopped.

An agent that just pushed should run it in the background (run_in_background) and will be woken up on exit.
It also answers at once when the CI finished before the command started.

Every wait is listed while it runs and in the history of waits ("queue waiters --history"): who, for what, from when to when, and how it ended
(matched, timeout, cancelled, refused, lost). See "queue waiters --help".

Exit codes: 0 CI passed | 1 CI failed | 2 timeout | 3 no run seen / relay not running | 4 invalid usage (including an unknown option)
`;

/** What HistoryReader calls an entry whose record carries no event name. */
const ORPHAN_EVENT_NAME = '(unknown)';

/** What a wait reads of the history: the entries of one name, or (`pattern`) of every name matching it, recorded at or after `sinceMs`. */
export interface HistoryRead {
  read: (options: { event?: string; pattern?: string; sinceMs: number }) => HistoryEntry[];
}

/**
 * The history a wait reads under `configDir`. It goes through `readRecent`: only the day files since the wait's `--since` are opened, in chunks, and only
 * the records of the wanted name are kept, so the memory of a wait does not grow with the history on disk (it was about twice its size).
 */
function recentHistoryOf(configDir: string): HistoryRead {
  const reader = new HistoryReader(pathJoin(configDir, 'history'));
  return {
    read: ({ event, pattern, sinceMs }) =>
      event !== undefined || pattern === undefined
        ? reader.readRecent({ ...(event !== undefined && { event }), sinceMs })
        : reader.readRecent({ match: { key: pattern, test: (name) => name !== ORPHAN_EVENT_NAME && EventMatcher.matches(pattern, name) }, sinceMs }),
  };
}

function fail(message: string): number {
  process.stderr.write(`[fail] ${message}\n`);
  return CI_EXIT.USAGE;
}

/** `queue wait <event> ...`: any target other than "ci" is the name of a queue event (or of several). */
async function eventWait(configDir: string, args: string[], startRelay: StartRelay, deps: QueueWaitDeps): Promise<number> {
  const parsed = parseEventWaitArgs(args, (deps.now ?? Date.now)());
  if (!parsed.ok) {
    return fail(parsed.message);
  }

  const { options } = parsed;

  // The catalog is read-only help: an undeclared name still waits (old and undeclared producers exist) unless --strict.
  // The events of the relay (on.<source>.<type>) are produced by the relay, nobody declares them: they are not checked.
  const declarations: Record<string, DeclarationCheck> = {};
  const checkedPatterns = new Set<string>();
  for (const { event } of options.targets) {
    // A pattern is never "declared" and --strict does not refuse it (names may come later): it only warns when nothing known matches
    if (isEventPattern(event)) {
      if (checkedPatterns.has(event)) {
        continue;
      }
      checkedPatterns.add(event);
      if (isRelayPattern(event)) {
        continue;
      }
      if (event === '>') {
        process.stderr.write(`[info] "${event}" matches relayed events (on.<source>.<type>) too, but does not start the relay client: use a pattern starting with "on." or run "queue relay start".\n`);
      }
      const check = patternMatchesKnownEvent(configDir, event, Date.now());
      if (!check.known) {
        process.stderr.write(`${patternWarning(event, check)}\n`);
      }
      continue;
    }
    if (isRelaySourcedEvent(event) || event in declarations) {
      continue;
    }
    const declaration = checkDeclaration(configDir, event, Date.now());
    declarations[event] = declaration;
    if (!declaration.declared) {
      if (options.strict) {
        return refuseUndeclared(event, declaration, options.json, { stdout: process.stdout, stderr: process.stderr });
      }
      process.stderr.write(`${undeclaredWarning(event, declaration)}\n`);
    }
  }
  const what = options.targets.map((target) => (target.whens.length ? `${target.event} where ${target.whens.join(' and ')}` : target.event));
  const joined = options.targets.length > 1 ? `${options.mode === 'all' ? 'all of' : 'any of'}: ${what.join('; ')}` : what[0]!;
  process.stderr.write(`[info] waiting for ${joined} (timeout ${Math.round(options.timeoutMs / 1000)}s)\n`);
  const reader = deps.historyReader ?? recentHistoryOf(configDir);
  const now = deps.now ?? (() => Date.now());

  // The wait is listed (and `queue push` counts it) from here on, before the history is read: a push that races its start is not missed
  const session = deps.session ?? defaultWaitSessionDeps(configDir);
  const name = anonymousWaitName(options.name, deps.pid ?? process.pid);
  if (options.name === undefined) {
    process.stderr.write(anonymousNameWarning(name, 'queue wait <event>'));
  }
  return runRegisteredWait({
    deps: session,
    outcomeOf: eventOutcomeOf,
    input: {
      name,
      events: [...new Set(options.targets.map((target) => target.event))],
      whens: registeredWhens(options.targets),
      label: '',
      since: new Date(options.sinceMs).toISOString(),
      cwd: process.cwd(),
    },
    run: async (report) => {
      // An event named on.<source>.<type> only arrives through the relay: make sure it runs while we wait for it
      let beforeFirstWait: (() => Promise<void>) | undefined;
      if (options.targets.some((target) => targetNeedsRelay(target.event))) {
        const onDemand = relayOnDemandFor(configDir, startRelay);
        onDemand.begin();
        beforeFirstWait = async () => {
          if (!(await onDemand.ensureRunning())) {
            process.stderr.write('[warn] Waiting without the relay client: no event of that kind can arrive until it runs (see the message above).\n');
          }
        };
      }

      return eventWaitCommand(options, {
        // A pattern reads the window once and keeps the names matching it (the reader only filters on an exact name); orphan records have no name
        readEntries: (event, sinceMs) =>
          isEventPattern(event)
            ? reader.read({ pattern: event, sinceMs }).filter((entry) => entry.event !== ORPHAN_EVENT_NAME && EventMatcher.matches(event, entry.event))
            : reader.read({ event, sinceMs }),
        now,
        // A wake from the daemon ends this sleep early; the history is read again and decides (deps.sleep replaces the timer in tests)
        sleep: (ms) => report.sleep(ms, deps.sleep),
        io: { stdout: process.stdout, stderr: process.stderr },
        beforeFirstWait,
        onMatched: (entry) => { report.matched({ eventId: entry.eventId, event: entry.event }); },
        declaration: Object.fromEntries(Object.entries(declarations).map(([event, check]) => [event, { declared: check.declared, suggestions: check.suggestions }])),
        lastSeenAt: (event) => lastSeenAtOf(configDir, event, Date.now()),
        lastSeenEvent: (pattern) => lastSeenEventOf(configDir, pattern, Date.now()),
      });
    },
  });
}

/**
 * The `--when` filters the wait registers (the daemon counts it for a push only when they hold). One filter list for the whole wait: the targets' lists when they are all the same,
 * none otherwise (a wait with different filters per event is counted for more pushes than needed, never for fewer).
 */
export function registeredWhens(targets: readonly EventWaitTarget[]): string[] {
  const first = targets[0]?.whens ?? [];
  return targets.every((target) => target.whens.length === first.length && target.whens.every((when, i) => when === first[i])) ? [...first] : [];
}

/** What a wait that needs the relay uses to start it: `queue relay start`, returning its exit code. */
export type StartRelay = () => Promise<number>;

function relayOnDemandFor(configDir: string, startRelay: StartRelay): RelayOnDemand {
  const relay = createRelayClient(configDir);
  return new RelayOnDemand({
    relayDir: relayStateDir(configDir),
    isRunning: () => relay.isRunning(),
    startRelay,
    io: { stderr: process.stderr },
  });
}

export interface QueueWaitDeps {
  /** The git the CI wait looks at; tests pass a fake, the CLI uses the real one. */
  git?: GitPort;
  /** How the wait registers itself (registry, heartbeat timer, signals, exit); tests pass fakes. Default: the real ones for `configDir`. */
  session?: WaitSessionDeps;
  /** The history the event wait reads; default: the one under `configDir`. */
  historyReader?: HistoryRead;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The pid an unnamed wait is called after (`anon.<pid>`). */
  pid?: number;
}

export async function queueWaitCommand(configDir: string, args: string[], startRelay: StartRelay, deps: QueueWaitDeps = {}): Promise<number> {
  const git = deps.git ?? createGitPort();
  const target = args[0];
  if (!target || target === '--help' || target === '-h') {
    process.stdout.write(WAIT_HELP);
    return target ? CI_EXIT.PASSED : CI_EXIT.USAGE;
  }
  if (target !== 'ci') {
    return eventWait(configDir, args, startRelay, deps);
  }

  const rest = args.slice(1);

  // A value flag without its value, in the --flag=value form or given twice is a usage error: each used to fall back to its default
  const parsedArgs = parseCiWaitArgs(rest);
  if (!parsedArgs.ok) {
    return fail(parsedArgs.message);
  }
  const positional = parsedArgs.sha;
  const sha = positional ?? git.read(['rev-parse', 'HEAD']);
  if (!sha) {
    return fail('No commit given and the current directory is not a git repository. Pass the SHA: queue wait ci <sha>.');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return fail(`"${sha}" is not a commit SHA (7 to 40 hexadecimal characters). Branch names are not resolved: pass the SHA.`);
  }

  const remote = git.read(['remote', 'get-url', 'origin']);
  const repo = parsedArgs.repo ?? (remote ? parseGithubRepo(remote) ?? undefined : undefined);
  if (!repo) {
    process.stderr.write('[warn] No --repo and no GitHub "origin" remote: any repository with this SHA will match.\n');
  } else if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return fail(`--repo must look like owner/name, got "${repo}".`);
  }

  let timeoutMs: number;
  let settleMs: number;
  try {
    timeoutMs = parseDuration(parsedArgs.timeout ?? WAIT_DEFAULT_TIMEOUT);
    settleMs = parseDuration(parsedArgs.settle ?? '20s');
  } catch (err) {
    return fail(`${getErrorMessage(err)} (durations look like 30s, 15m, 1h).`);
  }

  // --since: same syntax as the event wait (a duration back from now or a time); default 24 h
  let lookbackMs = CI_DEFAULT_LOOKBACK_MS;
  if (parsedArgs.since !== undefined) {
    const nowMs = (deps.now ?? Date.now)();
    const sinceMs = parseSince(parsedArgs.since, nowMs);
    if (sinceMs === null) {
      return fail(`--since "${parsedArgs.since}" is neither a duration (10m, 2h, 3d) nor a time (2026-10-18T11:00:00Z).`);
    }
    if (sinceMs >= nowMs) {
      return fail(`--since "${parsedArgs.since}" is in the future: give a duration back from now (3d) or a past time.`);
    }
    lookbackMs = nowMs - sinceMs;
  }

  const explicitWorkflows = parsedArgs.workflows;
  let workflows = explicitWorkflows;
  if (!parsedArgs.noInfer) {
    let refusal = '';
    const step = inspectRepository(git, { sha, repo, remoteRepo: remote ? parseGithubRepo(remote) : null, infer: explicitWorkflows.length === 0 }, (text) => {
      refusal += text;
      process.stderr.write(text);
    });
    if (!step.proceed) {
      // Exit 3 with --json: the reason is also an object on stdout, like every other result
      if (parsedArgs.json) {
        process.stdout.write(JSON.stringify({ sha, result: 'no-run', reason: refusal.trim().replace(/^\[fail\] /, ''), runs: [] }, null, 2) + '\n');
      }
      return step.exitCode;
    }
    for (const note of step.notes) process.stderr.write(`[info] ${note}\n`);
    if (explicitWorkflows.length === 0 && step.workflows.length > 0) {
      workflows = step.workflows;
      process.stderr.write(`[info] expecting ${workflows.map((w) => `"${w}"`).join(', ')} (from .github/workflows; --workflow or --no-infer to override)\n`);
    }
  }

  const options: CiWaitCommandOptions = {
    sha,
    repo,
    workflows,
    settleMs,
    timeoutMs,
    startGraceMs: 90_000,
    pollMs: 1000,
    lookbackMs,
    json: parsedArgs.json,
  };

  const reader = deps.historyReader ?? recentHistoryOf(configDir);
  const relay = createRelayClient(configDir);
  const now = deps.now ?? (() => Date.now());
  const name = anonymousWaitName(parsedArgs.name, deps.pid ?? process.pid);
  if (parsedArgs.name === undefined) {
    process.stderr.write(anonymousNameWarning(name, 'queue wait ci'));
  }

  // Listed before anything is read or started, like an event wait. The relay delivers the workflow runs of every repository under one name:
  // the sha in the label says which commit this wait is for
  return runRegisteredWait({
    deps: deps.session ?? defaultWaitSessionDeps(configDir),
    outcomeOf: ciOutcomeOf,
    input: { name, events: [CI_EVENT], whens: [], label: sha, since: new Date(now() - options.lookbackMs).toISOString(), cwd: process.cwd() },
    run: async (report) => {
      const onDemand = relayOnDemandFor(configDir, startRelay);
      onDemand.begin();

      return ciWaitCommand(options, {
        readEntries: (sinceMs) => reader.read({ event: CI_EVENT, sinceMs }),
        // Called only when the history holds nothing for this commit yet: a CI that already finished never starts the relay
        relayStatus: async () => {
          const wasRunning = await relay.isRunning().catch(() => false);
          if (!wasRunning && !(await onDemand.ensureRunning())) {
            return { running: false, connected: false };
          }
          const readStatus = async (): Promise<boolean> => {
            const status = await relay.send('status', undefined).catch(() => null);
            return Boolean(status && (status as { connected?: boolean }).connected);
          };
          let connected = await readStatus();
          // Just started: give it a moment to connect before saying it is not connected
          for (let attempt = 0; !wasRunning && !connected && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            connected = await readStatus();
          }
          return { running: true, connected };
        },
        now,
        sleep: (ms) => report.sleep(ms, deps.sleep),
        io: { stdout: process.stdout, stderr: process.stderr },
      });
    },
  });
}

/** The event the relay turns a GitHub workflow run into. */
const CI_EVENT = 'on.github.workflow_run';
