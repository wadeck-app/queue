/** Argument parsing and wiring of `queue wait ci` (the decision logic lives in ciWait.ts / ciWaitCommand.ts). */

import { join as pathJoin } from 'node:path';
import { EventMatcher, HistoryReader, getErrorMessage, isEventPattern } from '@wadeck-app/queue-core';
import { warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { createRelayClient, relayStateDir } from '@wadeck-app/queue-relay-client/dist/relayClient.js';
import { CI_EXIT } from './ciWait.js';
import { ciWaitCommand, parseGithubRepo, type CiWaitCommandOptions } from './ciWaitCommand.js';
import { createGitPort, inspectRepository, type GitPort } from './ciGit.js';
import { eventWaitCommand } from './eventWaitCommand.js';
import { RelayOnDemand, isRelayPattern, isRelaySourcedEvent, targetNeedsRelay } from './relayOnDemand.js';
import { checkDeclaration, lastSeenAtOf, lastSeenEventOf, patternMatchesKnownEvent, patternWarning, refuseUndeclared, undeclaredWarning, type DeclarationCheck } from './eventWaitCatalog.js';
import { parseEventWaitArgs, EVENT_WAIT_KNOWN_FLAGS, EVENT_WAIT_FLAGS_WITH_VALUE, WAIT_DEFAULT_TIMEOUT } from './eventWaitArgs.js';

export const WAIT_HELP = `queue wait - Block until something happens, so an agent does not have to poll
Usage:
  queue wait <event> [--when <expr>]... [<event> [--when <expr>]...]... [--all] [--since <duration|time>] [--timeout <duration>] [--json] [--strict]
  queue wait ci [<sha>] [--repo <owner/name>] [--workflow <name>]... [--timeout <duration>] [--settle <duration>] [--no-infer] [--json]

queue wait <event>: blocks until a queue event of that name (or matching that pattern) is recorded (any "queue push" is, even with no subscriber).
  --when <expr>      Keep only events whose payload satisfies the expression, same syntax as a subscriber's when:
                     "payload.taskId=abc" or a JSONPath such as "$.payload.newStatus". Repeatable: all must hold
  --since <d|time>   Count events recorded since then: a duration back from now (10m, 2h) or a time (2026-10-18T11:00:00Z).
                     Default: only events recorded after the command started
  --timeout <d>      Give up after this long (default 30m)
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
  "dep.a" and "dep.a.b" but not "dep"; a bare ">" is every event. "**" is rejected here (use ">"). A pattern matches names added later too.
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
  Exit codes: 0 matched | 2 timeout | 4 invalid usage / --strict on an undeclared name. "ci" is reserved for the command below.

queue wait ci: blocks until the GitHub CI of a commit is done (events relayed as on.github.workflow_run).
  <sha>              Commit to wait for (full or >= 7 chars); default: HEAD of the current git repository
  --repo <o/n>       Repository; default: the GitHub repository of the "origin" remote
  --workflow <name>  Exact workflow name that must complete (repeatable). Without it, the workflows are inferred from
                     .github/workflows (push trigger, branch and path filters); when that is undecidable, "done" means every run
                     seen for the commit is completed and nothing new happened for --settle
  --timeout <d>      Give up after this long (default 30m)
  --settle <d>       Quiet window before concluding with no --workflow (default 20s)
  --no-infer         Do not read git: no push check, no workflow inference
  --json             Machine-readable result on stdout

The relay client: "queue wait ci", and a wait for an event named on.<source>.<type> (on.github.workflow_run) or for a pattern
starting with "on." (on.github.*), need it. A bare ">" does not start it.
If it is not running and the history holds nothing yet, the wait starts it (relay.yml must exist, see "queue relay --help")
and the relay stops by itself 30s after the last such wait ended. A relay started with "queue relay start" is never stopped.

An agent that just pushed should run it in the background (run_in_background) and will be woken up on exit.
It also answers at once when the CI finished before the command started.

Exit codes: 0 CI passed | 1 CI failed | 2 timeout | 3 no run seen / relay not running | 4 invalid usage
`;

/** What HistoryReader calls an entry whose record carries no event name. */
const ORPHAN_EVENT_NAME = '(unknown)';

const FLAGS_WITH_VALUE = new Set(['--repo', '--workflow', '--timeout', '--settle']);
const KNOWN_FLAGS = ['--repo', '--workflow', '--timeout', '--settle', '--json', '--no-infer', '--help', '-h'];

function collectValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => { if (arg === flag && args[i + 1] !== undefined) values.push(args[i + 1]!); });
  return values;
}

function fail(message: string): number {
  process.stderr.write(`[fail] ${message}\n`);
  return CI_EXIT.USAGE;
}

/** `queue wait <event> ...`: any target other than "ci" is the name of a queue event (or of several). */
async function eventWait(configDir: string, args: string[], startRelay: StartRelay): Promise<number> {
  warnUnknownArgs(args.filter((arg) => arg.startsWith('-')), EVENT_WAIT_KNOWN_FLAGS, 'queue wait', EVENT_WAIT_FLAGS_WITH_VALUE);
  const parsed = parseEventWaitArgs(args, Date.now());
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
  const reader = new HistoryReader(pathJoin(configDir, 'history'));

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
    // A pattern reads the whole window once and filters by name (the reader only filters on an exact name); orphan records have no name
    readEntries: (event, sinceMs) =>
      isEventPattern(event)
        ? reader.read({ sinceMs }).filter((entry) => entry.event !== ORPHAN_EVENT_NAME && EventMatcher.matches(event, entry.event))
        : reader.read({ event, sinceMs }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    io: { stdout: process.stdout, stderr: process.stderr },
    beforeFirstWait,
    declaration: Object.fromEntries(Object.entries(declarations).map(([event, check]) => [event, { declared: check.declared, suggestions: check.suggestions }])),
    lastSeenAt: (event) => lastSeenAtOf(configDir, event, Date.now()),
    lastSeenEvent: (pattern) => lastSeenEventOf(configDir, pattern, Date.now()),
  });
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
}

export async function queueWaitCommand(configDir: string, args: string[], startRelay: StartRelay, deps: QueueWaitDeps = {}): Promise<number> {
  const git = deps.git ?? createGitPort();
  const target = args[0];
  if (!target || target === '--help' || target === '-h') {
    process.stdout.write(WAIT_HELP);
    return target ? CI_EXIT.PASSED : CI_EXIT.USAGE;
  }
  if (target !== 'ci') {
    return eventWait(configDir, args, startRelay);
  }

  const rest = args.slice(1);

  // The positional SHA is the first token that is neither a flag nor a flag's value
  const positionalIndex = rest.findIndex((arg, i) => !arg.startsWith('-') && !FLAGS_WITH_VALUE.has(rest[i - 1] ?? ''));
  const positional = positionalIndex === -1 ? undefined : rest[positionalIndex];
  warnUnknownArgs(rest.filter((_, i) => i !== positionalIndex), KNOWN_FLAGS, 'queue wait ci', FLAGS_WITH_VALUE);
  const sha = positional ?? git.read(['rev-parse', 'HEAD']);
  if (!sha) {
    return fail('No commit given and the current directory is not a git repository. Pass the SHA: queue wait ci <sha>.');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return fail(`"${sha}" is not a commit SHA (7 to 40 hexadecimal characters). Branch names are not resolved: pass the SHA.`);
  }

  const remote = git.read(['remote', 'get-url', 'origin']);
  const repo = collectValues(rest, '--repo')[0] ?? (remote ? parseGithubRepo(remote) ?? undefined : undefined);
  if (!repo) {
    process.stderr.write('[warn] No --repo and no GitHub "origin" remote: any repository with this SHA will match.\n');
  } else if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return fail(`--repo must look like owner/name, got "${repo}".`);
  }

  let timeoutMs: number;
  let settleMs: number;
  try {
    timeoutMs = parseDuration(collectValues(rest, '--timeout')[0] ?? WAIT_DEFAULT_TIMEOUT);
    settleMs = parseDuration(collectValues(rest, '--settle')[0] ?? '20s');
  } catch (err) {
    return fail(`${getErrorMessage(err)} (durations look like 30s, 15m, 1h).`);
  }

  const explicitWorkflows = collectValues(rest, '--workflow');
  let workflows = explicitWorkflows;
  if (!rest.includes('--no-infer')) {
    const step = inspectRepository(git, { sha, repo, remoteRepo: remote ? parseGithubRepo(remote) : null, infer: explicitWorkflows.length === 0 }, (text) => process.stderr.write(text));
    if (!step.proceed) {
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
    lookbackMs: 24 * 3600_000,
    json: rest.includes('--json'),
  };

  const reader = new HistoryReader(pathJoin(configDir, 'history'));
  const relay = createRelayClient(configDir);
  const onDemand = relayOnDemandFor(configDir, startRelay);
  onDemand.begin();

  return ciWaitCommand(options, {
    readEntries: (sinceMs) => reader.read({ event: 'on.github.workflow_run', sinceMs }),
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
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    io: { stdout: process.stdout, stderr: process.stderr },
  });
}
