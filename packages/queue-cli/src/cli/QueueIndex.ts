#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, renameSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join as pathJoin, dirname as pathDirname } from 'node:path';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { cliLogsCommand, cliVersionCommand, cliUpdateCommand, warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { readChannelFromConfig } from '@wadeck-app/shared-cli/ChannelConfig';
import { runSelfCheck } from '@wadeck-app/shared-cli';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { createQueueClient } from './QueueClient.js';
import { createRelayClient, relayStateDir } from '@wadeck-app/queue-relay-client/dist/relayClient.js';
import { relayStop } from './relayStop.js';
import { pinRelay } from '@wadeck-app/queue-relay-client/dist/onDemand.js';
import { queueWaitCommand } from './waitCli.js';
import { eventsCommand } from './eventsCli.js';
import { DaemonCommandNotFoundError } from '@wadeck-app/singleton-daemon-kit';
import { relayStart } from './relayStart.js';
import { diffNewEntries } from './HistoryFollower.js';
import { FOLLOW_POLL_INTERVAL_MS } from '@wadeck-app/shared-cli/FollowSnapshot';
import { HistoryFormatter } from './HistoryFormatter.js';
import { getErrorMessage, getQueueConfigDir, PROTOCOL_VERSION, SubscribersYmlSchema, HistoryReader, readQueueCounts, DEFAULT_HISTORY_LIMIT, spawnDetachedProcess, LogFormatter, readLogTail } from '@wadeck-app/queue-core';
import { spawnDaemon, getDaemonScriptPath } from './spawnDaemon.js';
import { pushFailure } from './pushOutcome.js';
import { isReleaseVersion, devBuildRefusalMessage } from '@wadeck-app/shared-cli/ReleaseVersion';
import { parseSubFlags, buildSubscriberEntry, locateSubscriber, renameSubscriber, unnamedLine } from './subscriberEntry.js';
import { parseProjectFlag, resolvePushProject, resolveProjectId, onlyProject } from './pushProject.js';
import { subscribersFileFor } from './subscribersFile.js';
import { readDaemonVersion, versionMismatchWarning } from './daemonVersion.js';
import { defaultRegistryDir } from '@wadeck-app/project-sdk';
import type { SubscriberConfig, HistoryFilter, HistoryEntry } from '@wadeck-app/queue-core';
import type { RelayStartDeps } from './relayStart.js';

declare const __QUEUE_CLI_VERSION__: string;

const require = createRequire(import.meta.url);

// Read on each call (not frozen at import) so the update guard can be tested with a stubbed build version.
function getVersion(): string {
  return typeof __QUEUE_CLI_VERSION__ !== 'undefined' ? __QUEUE_CLI_VERSION__ : '0.1.0-dev';
}

const VERSION = getVersion();

const DLQ_GROUP_HELP = `queue dlq - Dead Letter Queue management
Usage:
  queue dlq list [--project <name|alias|id>]
  queue dlq replay --id <id>
  queue dlq clear [--id <id>]
`;

const RELAY_GROUP_HELP = `queue relay - GitHub/Slack/Jira webhook relay client
Usage:
  queue relay start                                                Start the relay client as a background process (reads relay.yml from QUEUE_CONFIG_DIR)
  queue relay stop                                                 Stop the relay client
  queue relay status                                               Show whether the relay client is running and connected
  queue relay webhook list [--json]                                List configured webhooks and their health (1 HTTP request)
  queue relay webhook history [--limit N] [--event TYPE] [--source S] [--verified | --rejected] [--payload] [--json]  Show recent deliveries (1 HTTP request)

relay.yml example (in QUEUE_CONFIG_DIR):
  relayUrl: wss://<relay-host>/relay-ws
  plugins:
    - module: '@wadeck-app/plugin-github'
      subscriptions:
        - eventType: [push, pull_request]
          # payloadMatch compares top-level payload keys by equality (dotted paths are not supported yet)
          payloadMatch: { action: opened }

Relay token (stored securely, not in relay.yml):
  Put your consumer token in <QUEUE_CONFIG_DIR>/_secrets_/.env.local:
    QUEUE_RELAY_TOKEN=<your-relay-consumer-token>
  The _secrets_/ folder is git-ignored and protected.
  You can also export QUEUE_RELAY_TOKEN as an environment variable.

The relay client logs to <QUEUE_CONFIG_DIR>/relay-daemon/relay.log.

Nothing starts it at logon. "queue relay start" runs it until "queue relay stop". "queue wait ci" (or a wait for an
on.<source>.<type> event) starts it when it is down and the history holds nothing yet, and it stops by itself 30s after the
last such wait ended; "queue relay start" on a relay started that way keeps it running.
`;

const CLI_GROUP_HELP = `queue cli - CLI management commands
Usage:
  queue cli self-check
  queue cli update
  queue cli logs [--follow]
  queue cli --help

history is a domain concept, not CLI tooling -- use 'queue history' (top-level only, no 'queue cli history').
`;

const SUB_GROUP_HELP = `queue sub - Subscriber management
Usage:
  queue sub list [event] [--json] [--scope global|project]
  queue sub add <event> --name <name> --type cli --command "<cmd>" [options]
  queue sub add <event> --name <name> --type http --url "<url>" [options]
  queue sub remove <event> --index <N>|--name <name> [--scope global|project]
  queue sub edit <event> --index <N>|--name <name> --type cli|http [options]

Options:
  --scope global|project   File target: global=$QUEUE_CONFIG_DIR/subscribers.yml (default)
                           project=the config folder of the registered project of the cwd (register it first with: project add)
  --timeout <duration>     30s, 5m, 1h - dispatch timeout (default: 30s)
  --retries <n>            Max retries before DLQ (default: 5)
  --backoff <strategy>     exponential|linear (default: exponential)
  --when <expr>            Filter: payload.field=value or JSONPath $.field
  --header "key:value"     HTTP only; repeatable for multiple headers
  --method <verb>          HTTP only (default: POST)
  --name <name>            Who this subscriber is, e.g. notify (lowercase letters, digits, . _ -); it stays the same when the list is reordered. Kept by edit
  --index <N>              0-based subscriber index (remove/edit take --index or --name; with both, edit renames)

Aliases: queue subscribers
`;

function usage(): void {
  process.stdout.write(`queue v${VERSION}

Concepts:
  event       Dot-separated string, e.g. test.hello or before.save
  before.*    Synchronous: blocks caller, returns subscriber result, supports abort
  other.*     Asynchronous: fire-and-forget, WAL-tracked, retried on failure
  subscriber  Configured in $QUEUE_CONFIG_DIR/subscribers.yml (global)
              or the config folder of the registered project of the cwd (project)
  logs        Verbose per-dispatch debug trail (stdout/stderr), today's file only
  history     Terse audit trail: which events were triggered, which subscribers listened,
              with what outcome; spans all available days

Usage:
  queue push <event> <json> [--project <name|alias|id>] [--timeout <duration>]
  queue retry --event <id>
  queue replay <eventId> [--cwd <directory>]   Resubmit a past event's payload (from 'queue history') as a new event,
                             tagged replayOf <eventId>, run in the directory recorded with it (--cwd names another). For manual testing, not delivery guarantees.
  queue wait <event> [--when <expr>] [--since <d>] [--timeout <d>] [--json] [--strict]   Block until a matching queue event is recorded (see 'queue wait --help')
  queue events list [--source <s>] [--prefix <p>] [--match <pattern>] [--declared-only] [--terminal] [--json]   Event catalog: names, payloads, last seen
  queue events show <name> [--json]   Schema, example, payload paths for 'queue wait --when' and a ready command
  queue events register --source <s> --file <events.json> [--json]   Declare the events of a program that does not use the Node SDK
  queue wait ci [<sha>] [--workflow <name>] [--timeout <d>] [--json]   Block until the GitHub CI of a commit is done
  queue status [--project <name|alias|id>] [--json]
  queue list-subscribers [event] [--json]
  queue dlq list [--project <name|alias|id>]
  queue dlq replay --id <id>
  queue dlq clear [--id <id>]
  queue sub list [event] [--json] [--scope global|project]
  queue sub add <event> --name <name> --type cli --command "<cmd>" [options] [--scope global|project]
  queue sub add <event> --name <name> --type http --url "<url>" [options] [--scope global|project]
  queue sub remove <event> --index <N>|--name <name> [--scope global|project]
  queue sub edit <event> --index <N>|--name <name> --type cli|http [options] [--scope global|project]
  queue start
  queue stop
  queue relay start|stop|status [--json]   Webhook relay client (reads relay.yml from QUEUE_CONFIG_DIR)
  queue logs [--follow]
  queue history [--event <name>] [--subscriber <id>] [--project <name|alias|id>] [--status success|failed|dlq|filtered] [--since <-Nd|-Nh|-Nm>] [--limit|-n <N>] [--offset <N>] [--follow|-f] [--json]
  queue cli self-check
  queue cli update
  queue cli logs [--follow]

History options:
  --limit, -n <N>   Max entries to show (default: 20, matches flow-cli's history pagination)
                    With --follow: shows the last N entries, then streams new ones
  --offset <N>      Skip the first N matching entries (combine with --limit for paging)
                    Cannot be combined with --follow
  --follow, -f      Stream new history entries as they arrive; shows last N (default 20) first

Sub add/edit options:
  --timeout <duration>          Dispatch timeout, e.g. 30s, 5m (default: 30s)
  --retries <n>                 Max retries before DLQ (default: 5)
  --backoff exponential|linear  Retry backoff strategy (default: exponential)
  --when <expr>                 Filter: payload.field=value or JSONPath $.field
  --header "key:value"          HTTP only, repeatable
  --method <verb>               HTTP only (default: POST)

Status --json fields:
  daemonRunning, pendingCount, dlqCount, uptimeSec, pid, orchAvailable

Exit codes:
  0  success
  1  error
  2  daemon not running

Environment variables:
  QUEUE_CONFIG_DIR  Override config directory (default: ~/.config/queue)
`);
}

function getConfigDir(): string {
  return getQueueConfigDir();
}

async function queueLogsCommand(configDir: string, opts: { follow?: boolean } = {}): Promise<void> {
  const { existsSync: fsExists, watchFile, statSync, openSync, readSync, closeSync, unwatchFile } = await import('node:fs');
  const tail = readLogTail(configDir, { limit: Number.POSITIVE_INFINITY });
  const logFile = tail.file;
  if (!tail.present) {
    process.stdout.write(`No log file for today: ${logFile}\n`);
    if (!opts.follow) {
      return;
    }
  }
  for (const line of tail.lines) {
    process.stdout.write(line + '\n');
  }
  let offset = tail.bytes;
  if (!opts.follow) {
    return;
  }
  process.stderr.write(`[queue] Following ${logFile}\n`);
  await new Promise<void>((resolve) => {
    watchFile(logFile, { interval: 250 }, () => {
      if (!fsExists(logFile)) {
        return;
      }
      const size = statSync(logFile).size;
      if (size <= offset) {
        return;
      }
      const buf = Buffer.alloc(size - offset);
      const fd = openSync(logFile, 'r');
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const line of buf.toString('utf8').split('\n')) {
        const formatted = LogFormatter.format(line);
        if (formatted) {
          process.stdout.write(formatted + '\n');
        }
      }
    });
    process.on('SIGINT', () => { unwatchFile(logFile); resolve(); });
  });
}

const HISTORY_STATUSES = ['success', 'failed', 'dlq', 'filtered'] as const;

// Helper to check if flag is present in args (regardless of value)
function isFlagPresent(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1;
}

/** `projectRef`: the --project / -p given, a name, an alias or an id still to be resolved with the project registry. */
export function parseHistoryFlags(args: string[]): { filter: HistoryFilter; json: boolean; limit: number; offset: number; errors: string[]; projectRef?: string } {
  const errors: string[] = [];
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      return undefined;
    }
    const next = args[idx + 1];
    if (!next || next.startsWith('--')) {
      return undefined;
    }
    return next;
  };

  const filter: HistoryFilter = {};

  if (isFlagPresent(args, '--event')) {
    const eventVal = getArg('--event');
    if (eventVal === undefined) {
      errors.push('--event requires a value');
    } else {
      filter.event = eventVal;
    }
  }

  let projectRef: string | undefined;
  const projectFlag = ['--project', '-p'].find((flag) => isFlagPresent(args, flag));
  if (projectFlag !== undefined) {
    projectRef = getArg(projectFlag);
    if (projectRef === undefined) {
      errors.push('--project requires a value');
    }
  }

  if (isFlagPresent(args, '--subscriber')) {
    const subscriberVal = getArg('--subscriber');
    if (subscriberVal === undefined) {
      errors.push('--subscriber requires a value');
    } else {
      filter.subscriberId = subscriberVal;
    }
  }

  if (isFlagPresent(args, '--status')) {
    const statusVal = getArg('--status');
    if (statusVal === undefined) {
      errors.push('--status requires a value');
    } else if (!(HISTORY_STATUSES as readonly string[]).includes(statusVal)) {
      errors.push(`--status must be one of ${HISTORY_STATUSES.join('|')}, got: ${statusVal}`);
    } else {
      filter.status = statusVal as HistoryFilter['status'];
    }
  }

  if (isFlagPresent(args, '--since')) {
    const sinceVal = getArg('--since');
    if (sinceVal === undefined) {
      errors.push('--since requires a value');
    } else {
      try {
        filter.sinceMs = Date.now() - parseDuration(sinceVal.replace(/^-/, ''));
      } catch (err) {
        errors.push(`Invalid --since: ${getErrorMessage(err)} (expected Jira-style relative time, e.g. -3d, -2h, -30m)`);
      }
    }
  }

  // --limit/--offset match flow-cli's HistoryCommand.ts convention (-n/--limit, --offset, same
  // default of 20) -- history pagination should look the same across every CLI in the fleet.
  let limit = DEFAULT_HISTORY_LIMIT;
  // `--limit` wins over its `-n` alias when both are given
  const limitFlag = ['--limit', '-n'].find((flag) => isFlagPresent(args, flag));
  if (limitFlag) {
    const limitVal = getArg(limitFlag);
    if (limitVal === undefined) {
      errors.push(`${limitFlag} requires a value`);
    } else {
      const parsed = Number(limitVal);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        errors.push(`--limit must be a positive integer, got: ${limitVal}`);
      } else {
        limit = parsed;
      }
    }
  }

  let offset = 0;
  if (isFlagPresent(args, '--offset')) {
    const offsetVal = getArg('--offset');
    if (offsetVal === undefined) {
      errors.push('--offset requires a value');
    } else {
      const parsed = Number(offsetVal);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push(`--offset must be a non-negative integer, got: ${offsetVal}`);
      } else {
        offset = parsed;
      }
    }
  }

  return { filter, json: args.includes('--json'), limit, offset, errors, ...(projectRef !== undefined && { projectRef }) };
}

// Helper to inject dependencies into follow mode for testing (with AbortSignal support).
// When signal is aborted, the follow loop stops without clearing the interval.
export async function runFollowMode(deps: {
  reader: { read: (filter?: HistoryFilter) => HistoryEntry[] };
  filter?: HistoryFilter;
  limit: number;
  json: boolean;
  write: (text: string) => void;
  poll?: (intervalHandle: NodeJS.Timeout) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { reader, filter, limit, json, write, poll, signal } = deps;

  // Follow mode prints one entry per line (chronological), not the array/newest-first shape
  // of a one-shot read: a live tail is a stream of updates, not a snapshot document.
  const printEntry = (entry: HistoryEntry): void => {
    write((json ? JSON.stringify(entry) : HistoryFormatter.format(entry)) + '\n');
  };

  // Read all current entries, then take only the N most recent (tail -n semantics)
  const allRead = reader.read(filter);
  const sorted = [...allRead].sort((a, b) => a.ts.localeCompare(b.ts));
  const initial = sorted.slice(-limit);

  // Print only the limited initial batch in chronological order
  for (const entry of initial) printEntry(entry);

  // Snapshot must be built from the FULL read, not just the printed N.
  // Otherwise, entries not printed would be re-printed as "new" on the first poll.
  let snapshot = diffNewEntries(new Map(), allRead).snapshot;

  // If a custom poll function is provided (for testing), use it
  if (poll) {
    const interval = setInterval(() => {
      const { changed, snapshot: next } = diffNewEntries(snapshot, reader.read(filter));
      snapshot = next;
      for (const entry of changed) printEntry(entry);
    }, FOLLOW_POLL_INTERVAL_MS);
    try {
      await poll(interval);
    } finally {
      clearInterval(interval);
    }
    return;
  }

  // Production follow loop: poll every FOLLOW_POLL_INTERVAL_MS until SIGINT or signal aborted
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(interval);
        resolve();
        return;
      }
      const { changed, snapshot: next } = diffNewEntries(snapshot, reader.read(filter));
      snapshot = next;
      for (const entry of changed) printEntry(entry);
    }, FOLLOW_POLL_INTERVAL_MS);
    const handleSigint = () => { clearInterval(interval); process.removeListener('SIGINT', handleSigint); resolve(); };
    process.on('SIGINT', handleSigint);
    if (signal) {
      signal.addEventListener('abort', () => {
        process.removeListener('SIGINT', handleSigint);
        clearInterval(interval);
        resolve();
      });
    }
  });
}

async function queueHistoryCommand(configDir: string, args: string[]): Promise<void> {
  warnUnknownArgs(
    args,
    ['--event', '--subscriber', '--status', '--since', '--json', '--follow', '-f', '--limit', '-n', '--offset', '--project', '-p'],
    'queue history',
    new Set(['--event', '--subscriber', '--status', '--since', '--limit', '-n', '--offset', '--project', '-p']),
  );
  const { filter, json, limit, offset, errors, projectRef } = parseHistoryFlags(args);
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(`[fail] ${err}\n`);
    process.exit(1);
  }
  if (projectRef !== undefined) {
    const project = resolveProjectId(projectRef, defaultRegistryDir(process.env));
    if (!project.ok) {
      process.stderr.write(`[fail] ${project.message}\n`);
      process.exit(1);
    }
    filter.projectId = project.id;
  }

  const reader = new HistoryReader(pathJoin(configDir, 'history'));
  const follow = args.includes('--follow') || args.includes('-f');

  if (!follow) {
    const page = reader.readPage(filter, { limit, offset });
    if (json) {
      process.stdout.write(JSON.stringify(page, null, 2) + '\n');
      return;
    }
    if (page.entries.length === 0) {
      process.stdout.write('No history entries match.\n');
      return;
    }
    for (const entry of page.entries) {
      process.stdout.write(HistoryFormatter.format(entry) + '\n');
    }
    const shownFrom = page.offset + 1;
    const shownTo = page.offset + page.entries.length;
    process.stdout.write(`\nShowing ${shownFrom}-${shownTo} of ${page.total}.`);
    if (shownTo < page.total) {
      process.stdout.write(` Use --offset ${shownTo} for next page.`);
    }
    process.stdout.write('\n');
    return;
  }

  // --offset has no meaning with --follow (a live tail cannot skip entries)
  if (offset > 0) {
    process.stderr.write('[fail] --offset cannot be combined with --follow\n');
    process.exit(1);
  }

  // This is a deliberate behaviour change: with --follow, the initial dump shows the N most recent
  // entries (default 20), not all entries. This matches tail -n semantics and typical CLI expectations.
  process.stderr.write(`[queue] Following ${pathJoin(configDir, 'history')}\n`);
  await runFollowMode({
    reader,
    filter,
    limit,
    json,
    write: (text: string) => process.stdout.write(text),
  });
}

function formatUptime(sec: number): string {
  if (sec < 60) {
    return `${sec}s`;
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function getQueueDaemonScriptPath(): string {
  // Bundle layout: queue-daemon.cjs sits next to queue.cjs
  // TSC dev layout: ../daemon/daemon-entry.js relative to dist/cli/QueueIndex.js
  const bundleDaemon = fileURLToPath(new URL('./queue-daemon.cjs', import.meta.url));
  const tscDaemon = fileURLToPath(new URL('../daemon/daemon-entry.js', import.meta.url));
  return getDaemonScriptPath({ existsSync, bundlePath: bundleDaemon, tscPath: tscDaemon });
}

function spawnQueueDaemon(configDir: string): void {
  // Bundle layout: queue-daemon.cjs sits next to queue.cjs
  // TSC dev layout: ../daemon/daemon-entry.js relative to dist/cli/QueueIndex.js
  const bundleDaemon = fileURLToPath(new URL('./queue-daemon.cjs', import.meta.url));
  const tscDaemon = fileURLToPath(new URL('../daemon/daemon-entry.js', import.meta.url));
  spawnDaemon(configDir, { existsSync, bundlePath: bundleDaemon, tscPath: tscDaemon });
}

async function waitForDaemon(configDir: string, timeoutMs = 5000): Promise<boolean> {
  const client = createQueueClient(configDir);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await client.isRunning()) {
        return true;
      }
    } catch {
      // not yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function ensureDaemon(configDir: string): Promise<void> {
  const client = createQueueClient(configDir);
  const running = await client.isRunning().catch(() => false);
  // A daemon that was already running keeps the code it started with, whatever the CLI updated to since
  if (running) {
    const warning = versionMismatchWarning(await readDaemonVersion(configDir), getVersion());
    if (warning !== undefined) {
      process.stderr.write(`[warn] ${warning}\n`);
    }
  }
  if (!running) {
    spawnQueueDaemon(configDir);
    const started = await waitForDaemon(configDir, 5000);
    if (!started) {
      process.stderr.write('[queue] Failed to start daemon within 5s\n');
      process.exit(1);
    }
  }
}

async function waitForRelayDaemon(configDir: string, timeoutMs = 5000): Promise<boolean> {
  const client = createRelayClient(configDir);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await client.isRunning()) {
        return true;
      }
    } catch {
      // not yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** `queue relay start`; also what a `queue wait` runs when it needs the relay and finds it down. Returns relayStart's exit code. */
async function startRelayFromCli(configDir: string): Promise<number> {
  // Import loadRelayConfig from the relay package's compiled dist
  const { loadRelayConfig } = await import('@wadeck-app/queue-relay-client/dist/config.js');

  // Resolve relay daemon script: prefers bundled queue-relay-daemon.cjs if it exists,
  // otherwise falls back to the TSC-compiled relay-daemon-entry.js from queue-relay-client
  function resolveRelayScript(): string {
    const bundleRelay = fileURLToPath(new URL('./queue-relay-daemon.cjs', import.meta.url));
    if (existsSync(bundleRelay)) {
      return bundleRelay;
    }
    // Resolved lazily: the relay package is not installed next to a published (bundled) CLI
    return require.resolve('@wadeck-app/queue-relay-client/dist/relay-daemon-entry.js');
  }

  // Inject all dependencies into relayStart
  const deps: RelayStartDeps = {
    client: createRelayClient(configDir),
    loadConfig: (dir: string) => loadRelayConfig(dir),
    resolveDaemonScript: resolveRelayScript,
    getQueueDaemonScript: getQueueDaemonScriptPath,
    spawn: (script: string, dir: string, env: Record<string, string>) => spawnDetachedProcess(script, { QUEUE_CONFIG_DIR: dir, ...env }),
    waitForDaemon: (ms: number) => waitForRelayDaemon(configDir, ms),
    readLogTail: (path: string, lines: number) => {
      try {
        // Read only the last 8 KiB to avoid memory issues on large files
        const stat = statSync(path);
        const maxBytes = 8192;
        const bytesToRead = Math.min(maxBytes, stat.size);
        const buffer = Buffer.alloc(bytesToRead);
        const fd = openSync(path, 'r');
        try {
          readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
        } finally {
          closeSync(fd);
        }
        const content = buffer.toString('utf-8');
        return content.split('\n').slice(-lines).filter(l => l.trim());
      } catch {
        return null;
      }
    },
    io: { stdout: process.stdout, stderr: process.stderr },
  };

  return relayStart(deps, configDir);
}

async function relayCommand(configDir: string, rest: string[]): Promise<void> {
  const sub = rest[0];

  if (sub === '--help' || sub === '-h' || !sub) {
    process.stdout.write(RELAY_GROUP_HELP);
    return;
  }

  if (sub === 'start') {
    const exitCode = await startRelayFromCli(configDir);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    // A manual start makes the relay permanent, also when a "queue wait" had started it on demand
    pinRelay(relayStateDir(configDir));
    return;
  }

  if (sub === 'stop') {
    const client = createRelayClient(configDir);
    const io = { stdout: process.stdout, stderr: process.stderr };
    const exitCode = await relayStop(client, configDir, io);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    pinRelay(relayStateDir(configDir));
    return;
  }

  if (sub === 'status') {
    const jsonFlag = rest.includes('--json');
    const client = createRelayClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (!running) {
      const data = { relayRunning: false, connected: false };
      if (process.stdout.isTTY && !jsonFlag) {
        process.stdout.write('[fail] relay client: not running\n');
      } else {
        process.stdout.write(JSON.stringify(data) + '\n');
      }
      return;
    }
    const response = await client.send('status', undefined);
    if (process.stdout.isTTY && !jsonFlag) {
      process.stdout.write('[ok]  relay client: running\n');
      process.stdout.write(`      connected:    ${response.connected ? 'yes' : 'no'}\n`);
      process.stdout.write(`      uptime:       ${formatUptime(response.uptimeSec)}\n`);
      process.stdout.write(`      pid:          ${response.pid}\n`);
    } else {
      process.stdout.write(JSON.stringify({ relayRunning: true, ...response }) + '\n');
    }
    return;
  }

  if (sub === 'webhook') {
    // Webhook sub-commands (list, history)
    const webhookCmd = rest[1];

    if (webhookCmd === '--help' || webhookCmd === '-h' || !webhookCmd) {
      process.stdout.write(`queue relay webhook - Webhook configuration and delivery history
Usage:
  queue relay webhook list [--json]                                List configured webhooks and their health
  queue relay webhook history [--limit N] [--event TYPE] [--source S] [--verified | --rejected] [--payload] [--json]  Show recent deliveries

Both commands make exactly one HTTP request to the relay, using the relay token (QUEUE_RELAY_TOKEN from the environment or <configDir>/_secrets_/.env.local).
`);
      return;
    }

    // Load config and API client for webhook commands
    const { loadRelayConfig } = await import('@wadeck-app/queue-relay-client/dist/config.js');
    const { createRelayApiClient } = await import('@wadeck-app/queue-relay-client/dist/relayApi.js');

    let config;
    try {
      config = loadRelayConfig(configDir);
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      process.stderr.write(`[fail] ${errorMsg}\n`);
      process.exit(1);
    }

    if (config === null) {
      process.stderr.write(`[fail] No relay.yml in ${configDir}. Create it as:\n`);
      process.stderr.write(`  relayUrl: wss://<relay-host>/relay-ws\n`);
      process.stderr.write(`  plugins:\n`);
      process.stderr.write(`    - module: '@wadeck-app/plugin-github'\n`);
      process.stderr.write(`      subscriptions:\n`);
      process.stderr.write(`        - eventType: [push, pull_request]\n`);
      process.exit(1);
    }

    const apiClient = createRelayApiClient({
      relayUrl: config.relayUrl,
      token: config.token,
    });

    if (webhookCmd === 'list') {
      const { relayWebhookList } = await import('./relayWebhookList.js');
      const json = rest.slice(2).includes('--json');
      const { httpBaseFromRelayUrl } = await import('@wadeck-app/queue-relay-client/dist/relayApi.js');
      const exitCode = await relayWebhookList(apiClient, { stdout: process.stdout, stderr: process.stderr }, { json, origin: httpBaseFromRelayUrl(config.relayUrl) });
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    if (webhookCmd === 'history') {
      const { relayWebhookHistory } = await import('./relayWebhookHistory.js');
      const { BUILTIN_RELAY_PLUGINS } = await import('../relay/builtinPlugins.js');
      const json = rest.slice(2).includes('--json');
      const exitCode = await relayWebhookHistory(apiClient, { stdout: process.stdout, stderr: process.stderr }, { json, plugins: BUILTIN_RELAY_PLUGINS.map((entry) => entry.plugin) }, rest.slice(2));
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    process.stderr.write(`[fail] Unknown webhook command "${webhookCmd}". Use: list | history\n`);
    process.exit(1);
  }

  process.stderr.write(`Unknown relay subcommand: ${sub}\nUse: queue relay start|stop|status|webhook\n`);
  process.exit(1);
}

function resolveSubsFile(configDir: string, scope: string): string {
  const target = subscribersFileFor(scope === 'project' ? 'project' : 'global', { configDir, cwd: process.cwd(), registryDir: defaultRegistryDir(process.env) });
  if ('error' in target) {
    process.stderr.write(`[fail] ${target.error}
`);
    process.exit(1);
  }
  return target.file;
}

function readSubsYmlOrExit(filePath: string): { subscribers: Record<string, SubscriberConfig[]> } {
  if (!existsSync(filePath)) {
    return { subscribers: {} };
  }
  let raw: unknown;
  try {
    raw = yamlLoad(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[fail] Failed to parse YAML at ${filePath}: ${getErrorMessage(err)}\n`);
    process.exit(1);
  }
  const result = SubscribersYmlSchema.safeParse(raw);
  if (!result.success) {
    process.stderr.write(`[fail] Invalid subscribers.yml at ${filePath}:\n${result.error.toString()}\n`);
    process.exit(1);
  }
  return result.data as { subscribers: Record<string, SubscriberConfig[]> };
}

function writeSubsYmlOrExit(filePath: string, data: { subscribers: Record<string, SubscriberConfig[]> }): void {
  const result = SubscribersYmlSchema.safeParse(data);
  if (!result.success) {
    process.stderr.write(`[fail] Invalid subscriber config: ${result.error.toString()}\n`);
    process.exit(1);
  }
  const tmpPath = filePath + '.tmp';
  try {
    writeFileSync(tmpPath, yamlDump(data), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    process.stderr.write(`[fail] Failed to write ${filePath}: ${getErrorMessage(err)}\n`);
    process.exit(1);
  }
}

function isConfigDirWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const testFile = pathJoin(dir, '.write-test');
    writeFileSync(testFile, '');
    unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Log every CLI invocation to ~/.config/queue/logs/YYYY-MM-DD.ndjson
  try { logCliInvocation(getConfigDir(), 'queue', args); } catch { /* never block the CLI on logging failure */ }

  // Read and display any pending update notification before command output.
  // The config dir is passed explicitly: UpdateManager would otherwise resolve ~/.config/queue and ignore QUEUE_CONFIG_DIR,
  // so a test (or a relocated config) would read and clear the REAL update-state.json.
  const updateManager = new UpdateManager('@wadeck-app/queue-cli', getConfigDir());
  const updateState = updateManager.readAndClearState();
  if (updateState) {
    if (updateState.status === 'success') {
      process.stderr.write(`[queue] Updated to v${updateState.targetVersion ?? '?'}\n`);
    } else if (updateState.status === 'rolled-back') {
      process.stderr.write(`[queue] Update to v${updateState.targetVersion ?? '?'} failed (self-check), rolled back to v${updateState.previousVersion ?? '?'}\n`);
    } else if (updateState.status === 'failed') {
      process.stderr.write(`[queue] Background update failed: ${updateState.error ?? 'unknown'}\n`);
    }
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // Migrate config dir layout if needed (e.g. after package renames).
  ConfigDir.migrateIfNeeded('queue');

  const configDir = getConfigDir();
  const command = args[0]!;
  const rest = args.slice(1);
  const bundlePath = process.env['LAUNCHER_BUNDLE_OVERRIDE'] ?? fileURLToPath(import.meta.url);

  try {

  if (command === 'push') {
    const event = rest[0];
    const jsonArg = rest[1];

    if (!event || !jsonArg) {
      process.stderr.write('Usage: queue push <event> <json> [--project <name|alias|id>] [--timeout <duration>]\n');
      process.exit(1);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(jsonArg);
    } catch {
      process.stderr.write(`[queue] Invalid JSON payload: ${jsonArg}\n  Windows CMD: use "{""key"":""value""}" (double the inner quotes)\n  PowerShell / Bash: use '{"key":"value"}'\n`);
      process.exit(1);
    }

    let timeout: number | undefined;
    const timeoutIdx = rest.indexOf('--timeout');
    if (timeoutIdx !== -1 && rest[timeoutIdx + 1]) {
      try {
        timeout = parseDuration(rest[timeoutIdx + 1]!);
      } catch {
        process.stderr.write(`[queue] Invalid timeout: ${rest[timeoutIdx + 1]} (use e.g. 30s, 5m, 1h)\n`);
        process.exit(1);
      }
    }

    // --project / -p, else QUEUE_PROJECT: the project is resolved here (name, alias or id) and the push carries its id
    const projectFlag = parseProjectFlag(rest);
    if (projectFlag.error !== undefined) {
      process.stderr.write(`[fail] ${projectFlag.error}\n`);
      process.exit(1);
    }
    const target = resolvePushProject({ ...(projectFlag.value !== undefined && { flag: projectFlag.value }), cwd: process.cwd(), registryDir: defaultRegistryDir(process.env), env: process.env });
    if (!target.ok) {
      process.stderr.write(`[fail] ${target.message}\n`);
      process.exit(1);
    }

    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);

    const response = await client.send('push', { event, payload, timeout, cwd: target.cwd ?? process.cwd(), ...(target.project !== undefined && { project: target.project }) });

    const failure = pushFailure(response, 'Event');
    if (failure) {
      process.stderr.write(failure + '\n');
      process.exit(1);
    }

    if (event.startsWith('before')) {
      process.stdout.write(JSON.stringify(response.result ?? null) + '\n');
    } else {
      const count = response.subscriberCount ?? 0;
      if (count === 0) {
        process.stderr.write(`[warn] queued - no subscribers for '${event}'\n`);
      } else {
        process.stdout.write(`[ok] queued (${count} subscriber${count !== 1 ? 's' : ''})\n`);
      }
    }

    return;
  }

  if (command === 'retry') {
    const idIdx = rest.indexOf('--event');
    const eventId = idIdx !== -1 ? rest[idIdx + 1] : undefined;
    if (!eventId) {
      process.stderr.write('Usage: queue retry --event <id>\n');
      process.exit(1);
    }
    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);
    const response = await client.send('retry', { eventId });
    if (response.status === 'ok') {
      process.stdout.write('[ok] retry enqueued\n');
    } else {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
    return;
  }

  if (command === 'replay') {
    const eventId = rest[0];
    if (!eventId) {
      process.stderr.write('Usage: queue replay <eventId> [--cwd <directory>]\n');
      process.exit(1);
    }

    const reader = new HistoryReader(pathJoin(configDir, 'history'));
    const entry = reader.findByEventId(eventId);
    if (!entry) {
      process.stderr.write(`[fail] No history entry found for eventId ${eventId}\n`);
      process.exit(1);
    }
    if (entry.payload === undefined) {
      process.stderr.write(
        `[fail] No payload recorded for eventId ${eventId} -- it predates 'queue replay' support, or it's an orphan outcome with no trigger record\n`
      );
      process.exit(1);
    }

    // The directory decides which subscribers fire: the recorded one, or the one named with --cwd, never a guess
    const { resolveReplayCwd } = await import('./replayCwd.js');
    const cwdFlag = rest.indexOf('--cwd');
    const resolved = resolveReplayCwd(entry, cwdFlag === -1 ? undefined : rest[cwdFlag + 1]);
    if (!resolved.ok) {
      process.stderr.write(resolved.message + '\n');
      process.exit(1);
    }
    const replayCwd = resolved.cwd;

    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);
    const response = await client.send('push', { event: entry.event, payload: entry.payload, cwd: replayCwd, replayOf: eventId });

    const failure = pushFailure(response, 'Replay');
    if (failure) {
      process.stderr.write(failure + '\n');
      process.exit(1);
    }
    process.stdout.write(`[ok] replayed '${entry.event}' as eventId ${response.eventId ?? '?'} (replay of ${eventId})\n`);
    return;
  }

  if (command === 'status') {
    const jsonFlag = rest.includes('--json');
    const projectFlag = parseProjectFlag(rest);
    if (projectFlag.error !== undefined) {
      process.stderr.write(`[fail] ${projectFlag.error}\n`);
      process.exit(1);
    }
    let projectId: string | undefined;
    if (projectFlag.value !== undefined) {
      const project = resolveProjectId(projectFlag.value, defaultRegistryDir(process.env));
      if (!project.ok) {
        process.stderr.write(`[fail] ${project.message}\n`);
        process.exit(1);
      }
      projectId = project.id;
    }
    const client = createQueueClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (!running) {
      const data = { daemonRunning: false, pendingCount: 0, dlqCount: 0, ...(projectId !== undefined && { projectId }) };
      if (process.stdout.isTTY && !jsonFlag) {
        process.stdout.write('[fail] daemon: not running\n');
        process.stdout.write('       pending: 0\n');
        process.stdout.write('       dlq:     0\n');
      } else {
        process.stdout.write(JSON.stringify(data) + '\n');
      }
      return;
    }
    const daemonStatus = await client.send('status', undefined);
    // the counts of one project come from the queue files (the daemon counts everything), read here like the dashboard does
    const response = projectId === undefined ? daemonStatus : { ...daemonStatus, ...readQueueCounts(configDir, projectId) };
    const { execFileSync: execFS } = await import('node:child_process');
    let orchAvailable = false;
    try {
      execFS(process.platform === 'win32' ? 'where' : 'which', ['orch'], { stdio: 'pipe', windowsHide: true });
      orchAvailable = true;
    } catch {
      orchAvailable = false;
    }
    const daemonVersion = await readDaemonVersion(configDir);
    const mismatch = versionMismatchWarning(daemonVersion, getVersion());
    const data = { ...response, ...(projectId !== undefined && { projectId }), orchAvailable, ...(daemonVersion !== undefined && { daemonVersion }), cliVersion: getVersion() };
    if (mismatch !== undefined) {
      process.stderr.write(`[warn] ${mismatch}
`);
    }
    if (process.stdout.isTTY && !jsonFlag) {
      process.stdout.write('[ok]  daemon:  running\n');
      if (projectId !== undefined) {
        process.stdout.write(`      project: ${projectId} (pending and dlq count this project only)\n`);
      }
      process.stdout.write(`      pending: ${response.pendingCount}\n`);
      process.stdout.write(`      dlq:     ${response.dlqCount}\n`);
      process.stdout.write(`      uptime:  ${formatUptime(response.uptimeSec ?? 0)}\n`);
      process.stdout.write(`      pid:     ${response.pid ?? '?'}\n`);
      process.stdout.write(`      orch:    ${orchAvailable ? 'available' : 'not found'}\n`);
      process.stdout.write(`      version: ${daemonVersion ?? '?'}${daemonVersion === getVersion() ? '' : ` (this CLI: ${getVersion()})`}\n`);
    } else {
      process.stdout.write(JSON.stringify(data) + '\n');
    }
    return;
  }

  if (command === 'list-subscribers') {
    const jsonFlag = rest.includes('--json');
    // Event is the first non-flag argument
    const event = rest.find(arg => !arg.startsWith('--'));
    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);
    const response = await client.send('list-subscribers', { event, cwd: process.cwd() });
    if (process.stdout.isTTY && !jsonFlag) {
      if (response.subscribers.length === 0) {
        process.stdout.write('[ok] no subscribers\n');
      } else {
        for (const sub of response.subscribers) {
          const target = sub.type === 'cli' ? sub.command : sub.url;
          process.stdout.write(`[ok] ${sub.subscriberId}  ${sub.type}  ${target ?? '?'}\n`);
        }
      }
    } else {
      process.stdout.write(JSON.stringify(response.subscribers, null, 2) + '\n');
    }
    return;
  }

  if (command === 'dlq') {
    const sub = rest[0];

    if (sub === '--help' || sub === '-h') {
      process.stdout.write(DLQ_GROUP_HELP);
      return;
    }

    if (sub === 'list') {
      await ensureDaemon(configDir);
      const client = createQueueClient(configDir);
      const response = await client.send('dlq-list', undefined);
      const projectFlag = parseProjectFlag(rest);
      if (projectFlag.error !== undefined) {
        process.stderr.write(`[fail] ${projectFlag.error}\n`);
        process.exit(1);
      }
      let projectId: string | undefined;
      if (projectFlag.value !== undefined) {
        const project = resolveProjectId(projectFlag.value, defaultRegistryDir(process.env));
        if (!project.ok) {
          process.stderr.write(`[fail] ${project.message}\n`);
          process.exit(1);
        }
        projectId = project.id;
      }
      process.stdout.write(JSON.stringify(onlyProject(response.entries, projectId), null, 2) + '\n');
      return;
    }

    if (sub === 'replay') {
      const idIdx = rest.indexOf('--id');
      const id = idIdx !== -1 ? rest[idIdx + 1] : undefined;
      if (!id) {
        process.stderr.write('Usage: queue dlq replay --id <id>\n');
        process.exit(1);
      }
      await ensureDaemon(configDir);
      const client = createQueueClient(configDir);
      const response = await client.send('dlq-replay', { id });
      if (response.status === 'ok') {
        process.stdout.write('[ok] replayed\n');
      } else {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
      return;
    }

    if (sub === 'clear') {
      const idIdx = rest.indexOf('--id');
      const id = idIdx !== -1 ? rest[idIdx + 1] : undefined;
      await ensureDaemon(configDir);
      const client = createQueueClient(configDir);
      const response = await client.send('dlq-clear', { id });
      process.stdout.write(`[ok] cleared ${response.cleared} entries\n`);
      return;
    }

    process.stderr.write(`Unknown dlq subcommand: ${sub ?? '(none)'}\nUse: queue dlq list|replay|clear\n`);
    process.exit(1);
  }

  if (command === 'start') {
    const client = createQueueClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (running) {
      process.stderr.write('[ok] daemon already running\n');
      return;
    }
    spawnQueueDaemon(configDir);
    const started = await waitForDaemon(configDir, 5000);
    if (started) {
      process.stderr.write('[ok] daemon started\n');
    } else {
      process.stderr.write('[fail] daemon failed to start within 5s\n');
      process.exit(1);
    }
    return;
  }

  if (command === 'stop') {
    const client = createQueueClient(configDir);
    try {
      // 'quit' is a built-in daemon command; cast to bypass typing
      await (client.send as (cmd: string, payload?: unknown) => Promise<unknown>)('quit', undefined);
      process.stdout.write('[ok] daemon stopped\n');
    } catch {
      process.stderr.write('[fail] daemon not running or failed to stop\n');
    }
    return;
  }

  if (command === 'relay') {
    await relayCommand(configDir, rest);
    return;
  }

  // Backward-compatible top-level alias for `queue cli logs`
  if (command === 'logs') {
    await queueLogsCommand(configDir, { follow: rest.includes('--follow') || rest.includes('-f') });
    return;
  }

  if (command === 'events') {
    process.exit(await eventsCommand(rest, {
      configDir,
      io: { stdout: process.stdout, stderr: process.stderr },
      now: () => Date.now(),
      readFile: (path) => readFileSync(path, 'utf8'),
      protocolVersion: PROTOCOL_VERSION,
      register: async (request) => {
        await ensureDaemon(configDir);
        try {
          return { kind: 'response', response: await createQueueClient(configDir).send('register-events', request) };
        } catch (err) {
          // An older daemon answers 404 for a command it does not know
          if (err instanceof DaemonCommandNotFoundError) {
            return { kind: 'unsupported' };
          }
          throw err;
        }
      },
    }).catch((err: unknown) => {
      process.stderr.write(`[fail] queue events ${rest[0] ?? ''}: ${getErrorMessage(err)}\n`);
      return 1;
    }));
  }

  if (command === 'wait') {
    process.exit(await queueWaitCommand(configDir, rest, () => startRelayFromCli(configDir)));
  }

  // Domain concept (audit trail), not CLI tooling -- top-level only, no `queue cli history`.
  if (command === 'history') {
    await queueHistoryCommand(configDir, rest);
    return;
  }

  if (command === 'cli') {
    const sub = rest[0];

    if (!sub || sub === '--help' || sub === '-h') {
      process.stdout.write(CLI_GROUP_HELP);
      return;
    }

    if (sub === 'self-check') {
      const client = createQueueClient(configDir);

      await runSelfCheck([
        async () => ({
          name: `version: ${VERSION}`,
          ok: VERSION !== 'undefined' && !VERSION.startsWith('0.0.0-dev'),
        }),
        async () => ({
          name: 'config-dir',
          ok: isConfigDirWritable(configDir),
          detail: configDir,
        }),
        async () => {
          let daemonRunning = false;
          try { daemonRunning = await client.isRunning(); } catch { /* not running */ }
          if (!daemonRunning) {
            return { name: 'daemon', ok: true, detail: 'not running (skipped)' };
          }
          try {
            const info = await client.version();
            const ok = typeof info?.version === 'string' && info.version.length > 0;
            return {
              name: 'daemon',
              ok,
              detail: ok ? `running, v${info.version}` : `unexpected version response: ${JSON.stringify(info)}`,
            };
          } catch (e: unknown) {
            return { name: 'daemon', ok: false, detail: getErrorMessage(e) };
          }
        },
        async () => {
          const portFile = pathJoin(configDir, 'config.port');
          const { existsSync, readFileSync } = await import('node:fs');
          if (!existsSync(portFile)) {
            return { name: 'port-file', ok: true, detail: 'absent (skipped)' };
          }
          try {
            const data = JSON.parse(readFileSync(portFile, 'utf8'));
            const ok = typeof data?.port === 'number' && typeof data?.pid === 'number';
            return { name: 'port-file', ok, detail: ok ? 'port valid' : 'missing port or pid fields' };
          } catch (e: unknown) {
            return { name: 'port-file', ok: false, detail: getErrorMessage(e) };
          }
        },
      ]);
      process.exit(0);
    }

    if (sub === 'logs') {
      const subArgs = rest.slice(1);
      warnUnknownArgs(subArgs, ['--follow', '-f'], 'queue cli logs');
      await queueLogsCommand(configDir, { follow: subArgs.includes('--follow') || subArgs.includes('-f') });
      return;
    }

    if (sub === 'version') {
      warnUnknownArgs(rest.slice(1), [], 'queue cli version');
      const channel = readChannelFromConfig(configDir);
      await cliVersionCommand('@wadeck-app/queue-cli', VERSION, channel);
      return;
    }

    if (sub === 'update') {
      // Before anything with a side effect: a repo-built bundle must never run `npm install -g` (incident 2026-10-24/25).
      if (!isReleaseVersion(getVersion())) {
        process.stderr.write(`[fail] ${devBuildRefusalMessage('queue', getVersion())}\n`);
        process.exit(1);
      }
      const { dirname } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const updaterPath = pathJoin(dirname(bundlePath), 'queue-updater.cjs');
      if (!existsSync(updaterPath)) {
        process.stderr.write(`[fail] updater not found at: ${updaterPath}\n`);
        process.exit(1);
      }
      await cliUpdateCommand(updaterPath, '@wadeck-app/queue-cli', { rawArgs: rest.slice(1) });
      return;
    }

    process.stderr.write(`Unknown cli subcommand: ${sub}\nUse: queue cli version|self-check|update|logs\n`);
    process.exit(1);
  }

  if (command === 'sub' || command === 'subscribers') {
    const sub = rest[0];

    if (!sub || sub === '--help' || sub === '-h') {
      process.stdout.write(SUB_GROUP_HELP);
      return;
    }

    const scopeIdx = rest.indexOf('--scope');
    const scope = scopeIdx !== -1 && rest[scopeIdx + 1] ? rest[scopeIdx + 1]! : 'global';
    if (scope !== 'global' && scope !== 'project') {
      process.stderr.write(`[fail] --scope must be global or project, got: ${scope}\n`);
      process.exit(1);
    }

    if (sub === 'list') {
      const jsonFlag = rest.includes('--json');
      const eventArg = rest.slice(1).find(a => !a.startsWith('--') && a !== scope);

      if (scopeIdx === -1) {
        // No --scope: delegate to daemon (same as queue list-subscribers)
        await ensureDaemon(configDir);
        const client = createQueueClient(configDir);
        const response = await client.send('list-subscribers', { event: eventArg, cwd: process.cwd() });
        if (process.stdout.isTTY && !jsonFlag) {
          if (response.subscribers.length === 0) {
            process.stdout.write('[ok] no subscribers\n');
          } else {
            for (const s of response.subscribers) {
              const target = s.type === 'cli' ? s.command : s.url;
              process.stdout.write(`[ok] ${s.subscriberId}  ${s.type}  ${target ?? '?'}\n`);
            }
          }
        } else {
          process.stdout.write(JSON.stringify(response.subscribers, null, 2) + '\n');
        }
        return;
      }

      // --scope provided: read YAML file directly
      const filePath = resolveSubsFile(configDir, scope);
      const data = readSubsYmlOrExit(filePath);
      const entries: Array<{ subscriberId: string; event: string; type: string; command?: string; url?: string }> = [];
      for (const [evtPattern, subs] of Object.entries(data.subscribers)) {
        if (eventArg && evtPattern !== eventArg) {
          continue;
        }
        for (let i = 0; i < subs.length; i++) {
          const s = subs[i]!;
          entries.push({ subscriberId: s.name ?? `(unnamed: ${evtPattern} index ${i})`, event: evtPattern, type: s.type, command: s.command, url: s.url });
          if (s.name === undefined) {
            process.stderr.write(`${unnamedLine(evtPattern, i, scope)}\n`);
          }
        }
      }
      if (process.stdout.isTTY && !jsonFlag) {
        if (entries.length === 0) {
          process.stdout.write('[ok] no subscribers\n');
        } else {
          for (const e of entries) {
            const target = e.type === 'cli' ? e.command : e.url;
            process.stdout.write(`[ok] ${e.subscriberId}  ${e.type}  ${target ?? '?'}\n`);
          }
        }
      } else {
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
      }
      return;
    }

    if (sub !== 'add' && sub !== 'remove' && sub !== 'edit') {
      process.stderr.write(`Unknown sub subcommand: ${sub ?? '(none)'}\nUse: queue sub list|add|remove|edit\n`);
      process.exit(1);
    }

    const event = rest[1];
    if (!event || event.startsWith('--')) {
      process.stderr.write(`Usage: queue sub ${sub} <event> [...]\n`);
      process.exit(1);
    }

    if (sub === 'add') {
      const { config, errors } = parseSubFlags(rest.slice(2));
      if (errors.length > 0) {
        for (const e of errors) process.stderr.write(`[fail] ${e}\n`);
        process.exit(1);
      }
      if (!config.type) {
        process.stderr.write(`[fail] --type cli|http is required\nUsage: queue sub add <event> --type cli|http ...\n`);
        process.exit(1);
      }
      if (config.name === undefined) {
        process.stderr.write(`[fail] --name is required: it tells the dashboard, the history, the DLQ and the logs who listens, e.g. --name notify\n`);
        process.exit(1);
      }
      if (config.type === 'cli' && !config.command) {
        process.stderr.write(`[fail] --command is required for type: cli\n`);
        process.exit(1);
      }
      if (config.type === 'http' && !config.url) {
        process.stderr.write(`[fail] --url is required for type: http\n`);
        process.exit(1);
      }

      const filePath = resolveSubsFile(configDir, scope);
      if (scope === 'project') {
        mkdirSync(pathDirname(filePath), { recursive: true });
      }
      const data = readSubsYmlOrExit(filePath);
      const existing = data.subscribers[event] ?? [];
      if (existing.some((entry) => entry.name === config.name)) {
        process.stderr.write(`[fail] '${event}' already has a subscriber named '${config.name}' in ${filePath}: a name identifies one subscriber of an event. Choose another --name, or edit that one: queue sub edit ${event} --name ${config.name} ...\n`);
        process.exit(1);
      }
      const newEntry = buildSubscriberEntry(config);
      data.subscribers[event] = [...existing, newEntry];
      writeSubsYmlOrExit(filePath, data);
      process.stdout.write(`[ok] Added subscriber '${config.name}' to '${event}' (index ${existing.length}) in ${filePath}\n`);
      return;
    }

    if (sub === 'remove') {
      const filePath = resolveSubsFile(configDir, scope);
      if (!existsSync(filePath)) {
        process.stderr.write(`[fail] No subscribers file at: ${filePath}\n`);
        process.exit(1);
      }
      const data = readSubsYmlOrExit(filePath);
      const subs = data.subscribers[event] ?? [];
      const located = locateSubscriber(subs, event, rest.slice(2));
      if ('error' in located) {
        process.stderr.write(`[fail] ${located.error}\n`);
        process.exit(1);
      }
      const index = located.index;
      data.subscribers[event] = subs.filter((_, i) => i !== index);
      if (data.subscribers[event]!.length === 0) {
        delete data.subscribers[event];
      }
      writeSubsYmlOrExit(filePath, data);
      process.stdout.write(`[ok] Removed subscriber at index ${index} from '${event}' in ${filePath}\n`);
      return;
    }

    if (sub === 'edit') {
      const filePath = resolveSubsFile(configDir, scope);
      if (!existsSync(filePath)) {
        process.stderr.write(`[fail] No subscribers file at: ${filePath}\n`);
        process.exit(1);
      }
      const data = readSubsYmlOrExit(filePath);
      const subs = data.subscribers[event] ?? [];
      const located = locateSubscriber(subs, event, rest.slice(2));
      if ('error' in located) {
        process.stderr.write(`[fail] ${located.error}\n`);
        process.exit(1);
      }
      const index = located.index;
      const { config, errors } = parseSubFlags(rest.slice(2));
      if (errors.length > 0) {
        for (const e of errors) process.stderr.write(`[fail] ${e}\n`);
        process.exit(1);
      }
      const renamed = renameSubscriber(subs, index, config);
      if (renamed !== undefined) {
        if ('error' in renamed) {
          process.stderr.write(`[fail] ${renamed.error}\n`);
          process.exit(1);
        }
        data.subscribers[event] = renamed.subs;
        writeSubsYmlOrExit(filePath, data);
        process.stdout.write(`[ok] Named the subscriber at index ${index} of '${event}' '${config.name}' in ${filePath}\n`);
        return;
      }
      if (!config.type) {
        process.stderr.write(`[fail] --type cli|http is required (or only --name, to name the subscriber and keep the rest)\nUsage: queue sub edit <event> --index <N> --type cli|http ...\n`);
        process.exit(1);
      }
      if (config.type === 'cli' && !config.command) {
        process.stderr.write(`[fail] --command is required for type: cli\n`);
        process.exit(1);
      }
      if (config.type === 'http' && !config.url) {
        process.stderr.write(`[fail] --url is required for type: http\n`);
        process.exit(1);
      }
      const newEntry = buildSubscriberEntry(config, subs[index]);
      data.subscribers[event] = subs.map((s, i) => (i === index ? newEntry : s));
      writeSubsYmlOrExit(filePath, data);
      process.stdout.write(`[ok] Updated subscriber at index ${index} for '${event}' in ${filePath}\n`);
      return;
    }

  }

  process.stderr.write(`Unknown command: ${command}\n`);
  usage();
  process.exit(1);

  } finally {
    // The version is passed so that a dev build (not a release) spawns nothing: it would run `npm install -g` from a repo build
    updateManager.scheduleBackgroundUpdate(bundlePath, 'queue-updater.cjs', getVersion());
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile || process.argv[1]?.endsWith('QueueIndex.js') || process.argv[1]?.endsWith('QueueIndex.ts') || process.argv[1]?.endsWith('queue.cjs')) {
  main().catch((err: unknown) => {
    process.stderr.write(`[queue] Fatal error: ${getErrorMessage(err)}\n`);
    process.exit(1);
  });
}

export { main as runQueueCommand };
