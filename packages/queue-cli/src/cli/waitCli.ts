/** Argument parsing and wiring of `queue wait ci` (the decision logic lives in ciWait.ts / ciWaitCommand.ts). */

import { join as pathJoin } from 'node:path';
import { HistoryReader, getErrorMessage } from '@wadeck-app/queue-core';
import { warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { createRelayClient, relayStateDir } from '@wadeck-app/queue-relay-client/dist/relayClient.js';
import { CI_EXIT } from './ciWait.js';
import { ciWaitCommand, parseGithubRepo, type CiWaitCommandOptions } from './ciWaitCommand.js';
import { createGitPort, inspectRepository, type GitPort } from './ciGit.js';
import { eventWaitCommand } from './eventWaitCommand.js';
import { RelayOnDemand, isRelaySourcedEvent } from './relayOnDemand.js';
import { checkDeclaration, lastSeenAtOf, refuseUndeclared, undeclaredWarning } from './eventWaitCatalog.js';
import { parseEventWaitArgs, EVENT_WAIT_KNOWN_FLAGS, EVENT_WAIT_FLAGS_WITH_VALUE } from './eventWaitArgs.js';

export const WAIT_HELP = `queue wait - Block until something happens, so an agent does not have to poll
Usage:
  queue wait <event> [--when <expr>]... [--since <duration|time>] [--timeout <duration>] [--json] [--strict]
  queue wait ci [<sha>] [--repo <owner/name>] [--workflow <name>]... [--timeout <duration>] [--settle <duration>] [--no-infer] [--json]

queue wait <event>: blocks until a queue event of that name is recorded (any "queue push" is, even with no subscriber).
  --when <expr>      Keep only events whose payload satisfies the expression, same syntax as a subscriber's when:
                     "payload.taskId=abc" or a JSONPath such as "$.payload.newStatus". Repeatable: all must hold
  --since <d|time>   Count events recorded since then: a duration back from now (10m, 2h) or a time (2026-10-18T11:00:00Z).
                     Default: only events recorded after the command started
  --timeout <d>      Give up after this long (default 15m)
  --json             Machine-readable result on stdout ({"matched":true,"entry":{...}} or {"matched":false,"timedOut":true,...}),
                     plus "declared" (is the name in the event catalog), "suggestions" (nearest declared names) and, on a
                     timeout, "lastSeenAt" (last push of that name in the last 7 days, null = none: a typo or a rename,
                     as opposed to a slow producer)
  --strict           An event name that no program declared exits 4 at once, with the nearest declared names. Without it the
                     wait goes on (old and undeclared producers exist) and warns on stderr with the same suggestions
  Example: queue wait onStatusChange --when "payload.taskId=abc" --when "payload.newStatus=done" --since 5m
  It answers at once when a matching event was recorded since --since, so there is no race with the thing you waited for.
  Find the names, the payload paths for --when and a ready command with "queue events list" and "queue events show <name>".
  Exit codes: 0 matched | 2 timeout | 4 invalid usage / --strict on an undeclared name. "ci" is reserved for the command below.

queue wait ci: blocks until the GitHub CI of a commit is done (events relayed as on.github.workflow_run).
  <sha>              Commit to wait for (full or >= 7 chars); default: HEAD of the current git repository
  --repo <o/n>       Repository; default: the GitHub repository of the "origin" remote
  --workflow <name>  Exact workflow name that must complete (repeatable). Without it, the workflows are inferred from
                     .github/workflows (push trigger, branch and path filters); when that is undecidable, "done" means every run
                     seen for the commit is completed and nothing new happened for --settle
  --timeout <d>      Give up after this long (default 15m)
  --settle <d>       Quiet window before concluding with no --workflow (default 20s)
  --no-infer         Do not read git: no push check, no workflow inference
  --json             Machine-readable result on stdout

The relay client: "queue wait ci", and a wait for an event named on.<source>.<type> (on.github.workflow_run), need it.
If it is not running and the history holds nothing yet, the wait starts it (relay.yml must exist, see "queue relay --help")
and the relay stops by itself 30s after the last such wait ended. A relay started with "queue relay start" is never stopped.

An agent that just pushed should run it in the background (run_in_background) and will be woken up on exit.
It also answers at once when the CI finished before the command started.

Exit codes: 0 CI passed | 1 CI failed | 2 timeout | 3 no run seen / relay not running | 4 invalid usage
`;

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

/** `queue wait <event> ...`: any target other than "ci" is the name of a queue event. */
async function eventWait(configDir: string, args: string[], startRelay: StartRelay): Promise<number> {
  warnUnknownArgs(args.filter((arg) => arg.startsWith('-')), EVENT_WAIT_KNOWN_FLAGS, 'queue wait', EVENT_WAIT_FLAGS_WITH_VALUE);
  const parsed = parseEventWaitArgs(args, Date.now());
  if (!parsed.ok) {
    return fail(parsed.message);
  }

  const { options } = parsed;

  // The catalog is read-only help: an undeclared name still waits (old and undeclared producers exist) unless --strict.
  // The events of the relay (on.<source>.<type>) are produced by the relay, nobody declares them: they are not checked.
  const relaySourced = isRelaySourcedEvent(options.event);
  const declaration = checkDeclaration(configDir, options.event, Date.now());
  if (!relaySourced && !declaration.declared) {
    if (options.strict) {
      return refuseUndeclared(options.event, declaration, options.json, { stdout: process.stdout, stderr: process.stderr });
    }
    process.stderr.write(`${undeclaredWarning(options.event, declaration)}\n`);
  }
  process.stderr.write(`[info] waiting for ${options.event}${options.whens.length ? ` where ${options.whens.join(' and ')}` : ''} (timeout ${Math.round(options.timeoutMs / 1000)}s)\n`);
  const reader = new HistoryReader(pathJoin(configDir, 'history'));

  // An event named on.<source>.<type> only arrives through the relay: make sure it runs while we wait for it
  let beforeFirstWait: (() => Promise<void>) | undefined;
  if (isRelaySourcedEvent(options.event)) {
    const onDemand = relayOnDemandFor(configDir, startRelay);
    onDemand.begin();
    beforeFirstWait = async () => {
      if (!(await onDemand.ensureRunning())) {
        process.stderr.write('[warn] Waiting without the relay client: no event of that kind can arrive until it runs (see the message above).\n');
      }
    };
  }

  return eventWaitCommand(options, {
    readEntries: (sinceMs) => reader.read({ event: options.event, sinceMs }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    io: { stdout: process.stdout, stderr: process.stderr },
    beforeFirstWait,
    ...(!relaySourced && { declaration: { declared: declaration.declared, suggestions: declaration.suggestions } }),
    lastSeenAt: () => lastSeenAtOf(configDir, options.event, Date.now()),
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
    timeoutMs = parseDuration(collectValues(rest, '--timeout')[0] ?? '15m');
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
