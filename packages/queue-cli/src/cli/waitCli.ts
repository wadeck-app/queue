/** Argument parsing and wiring of `queue wait ci` (the decision logic lives in ciWait.ts / ciWaitCommand.ts). */

import { execFileSync } from 'node:child_process';
import { join as pathJoin } from 'node:path';
import { HistoryReader } from '@wadeck-app/queue-core';
import { warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { createRelayClient } from './RelayClient.js';
import { CI_EXIT } from './ciWait.js';
import { ciWaitCommand, parseGithubRepo, type CiWaitCommandOptions } from './ciWaitCommand.js';

export const WAIT_HELP = `queue wait - Block until something happens, so an agent does not have to poll
Usage:
  queue wait ci [<sha>] [--repo <owner/name>] [--workflow <name>]... [--timeout <duration>] [--settle <duration>] [--json]

queue wait ci: blocks until the GitHub CI of a commit is done (events relayed as on.github.workflow_run).
  <sha>              Commit to wait for (full or >= 7 chars); default: HEAD of the current git repository
  --repo <o/n>       Repository; default: the GitHub repository of the "origin" remote
  --workflow <name>  Exact workflow name that must complete (repeatable). Without it, "done" means every run
                     seen for the commit is completed and nothing new happened for --settle
  --timeout <d>      Give up after this long (default 15m)
  --settle <d>       Quiet window before concluding with no --workflow (default 20s)
  --json             Machine-readable result on stdout

An agent that just pushed should run it in the background (run_in_background) and will be woken up on exit.
It also answers at once when the CI finished before the command started.

Exit codes: 0 CI passed | 1 CI failed | 2 timeout | 3 no run seen / relay not running | 4 invalid usage
`;

const FLAGS_WITH_VALUE = new Set(['--repo', '--workflow', '--timeout', '--settle']);
const KNOWN_FLAGS = ['--repo', '--workflow', '--timeout', '--settle', '--json', '--help', '-h'];

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

function collectValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, i) => { if (arg === flag && args[i + 1] !== undefined) values.push(args[i + 1]!); });
  return values;
}

function fail(message: string): number {
  process.stderr.write(`[fail] ${message}\n`);
  return CI_EXIT.USAGE;
}

export async function queueWaitCommand(configDir: string, args: string[]): Promise<number> {
  const target = args[0];
  if (!target || target === '--help' || target === '-h') {
    process.stdout.write(WAIT_HELP);
    return target ? CI_EXIT.PASSED : CI_EXIT.USAGE;
  }
  if (target !== 'ci') return fail(`Unknown wait target "${target}". Use: queue wait ci (see "queue wait --help").`);

  const rest = args.slice(1);

  // The positional SHA is the first token that is neither a flag nor a flag's value
  const positionalIndex = rest.findIndex((arg, i) => !arg.startsWith('-') && !FLAGS_WITH_VALUE.has(rest[i - 1] ?? ''));
  const positional = positionalIndex === -1 ? undefined : rest[positionalIndex];
  warnUnknownArgs(rest.filter((_, i) => i !== positionalIndex), KNOWN_FLAGS, 'queue wait ci', FLAGS_WITH_VALUE);
  const sha = positional ?? git(['rev-parse', 'HEAD']);
  if (!sha) return fail('No commit given and the current directory is not a git repository. Pass the SHA: queue wait ci <sha>.');
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return fail(`"${sha}" is not a commit SHA (7 to 40 hexadecimal characters). Branch names are not resolved: pass the SHA.`);

  const remote = git(['remote', 'get-url', 'origin']);
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
    return fail(`${err instanceof Error ? err.message : String(err)} (durations look like 30s, 15m, 1h).`);
  }

  const options: CiWaitCommandOptions = {
    sha,
    repo,
    workflows: collectValues(rest, '--workflow'),
    settleMs,
    timeoutMs,
    startGraceMs: 90_000,
    pollMs: 1000,
    lookbackMs: 24 * 3600_000,
    json: rest.includes('--json'),
  };

  const reader = new HistoryReader(pathJoin(configDir, 'history'));
  const relay = createRelayClient(configDir);

  return ciWaitCommand(options, {
    readEntries: (sinceMs) => reader.read({ event: 'on.github.workflow_run', sinceMs }),
    relayStatus: async () => {
      if (!(await relay.isRunning().catch(() => false))) return { running: false, connected: false };
      const status = await relay.send('status', undefined).catch(() => null);
      return { running: true, connected: Boolean(status && (status as { connected?: boolean }).connected) };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    io: { stdout: process.stdout, stderr: process.stderr },
  });
}
