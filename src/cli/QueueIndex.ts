#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { cliLogsCommand, cliVersionCommand, cliUpdateCommand, warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { readChannelFromConfig } from '@wadeck-app/shared-cli/ChannelConfig';
import { runSelfCheck } from '@wadeck-app/shared-cli';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { createQueueClient } from './QueueClient.js';
import { getErrorMessage } from '../errors.js';
import type { SubscriberConfig } from '../ConfigLoader.js';
import { SubscribersYmlSchema } from '../ConfigLoader.js';

declare const __QUEUE_CLI_VERSION__: string;

const VERSION = typeof __QUEUE_CLI_VERSION__ !== 'undefined' ? __QUEUE_CLI_VERSION__ : '0.1.0-dev';

const DLQ_GROUP_HELP = `queue dlq - Dead Letter Queue management
Usage:
  queue dlq list
  queue dlq replay --id <id>
  queue dlq clear [--id <id>]
`;

const CLI_GROUP_HELP = `queue cli - CLI management commands
Usage:
  queue cli self-check
  queue cli update
  queue cli logs [--follow]
  queue cli --help
`;

const SUB_GROUP_HELP = `queue sub - Subscriber management commands
Usage:
  queue sub list [event] [--json] [--scope global|project]
  queue sub add <event> --type cli --command "..." [--timeout <d>] [--retries <n>] [--backoff exponential|linear] [--when <expr>] [--scope global|project]
  queue sub add <event> --type http --url "..." [--method <m>] [--header "key:value"] [--timeout <d>] [--retries <n>] [--backoff exponential|linear] [--when <expr>] [--scope global|project]
  queue sub remove <event> --index <N> [--scope global|project]
  queue sub edit <event> --index <N> --type cli|http [...] [--scope global|project]

Aliases: queue subscribers
Scopes: global (default) = $QUEUE_CONFIG_DIR/subscribers.yml, project = .queue/subscribers.yml in cwd
`;

function usage(): void {
  process.stdout.write(`queue v${VERSION}
Usage:
  queue push <event> <json> [--timeout <duration>]
  queue retry --event <id>
  queue status [--json]
  queue list-subscribers [event] [--json]
  queue dlq list
  queue dlq replay --id <id>
  queue dlq clear [--id <id>]
  queue sub list [event] [--json] [--scope global|project]
  queue sub add <event> --type cli|http [...] [--scope global|project]
  queue sub remove <event> --index <N> [--scope global|project]
  queue sub edit <event> --index <N> [...] [--scope global|project]
  queue start
  queue stop
  queue logs [--follow]
  queue cli self-check
  queue cli update
  queue cli logs [--follow]

Exit codes:
  0  success
  1  error
  2  daemon not running

Environment variables:
  QUEUE_CONFIG_DIR  Override config directory path
`);
}

function getConfigDir(): string {
  return process.env['QUEUE_CONFIG_DIR'] ?? ConfigDir.get('queue');
}

function spawnDaemon(configDir: string): void {
  // Bundle layout: queue-daemon.cjs sits next to queue.cjs
  // TSC dev layout: ../daemon/daemon-entry.js relative to dist/cli/QueueIndex.js
  const bundleDaemon = fileURLToPath(new URL('./queue-daemon.cjs', import.meta.url));
  const tscDaemon = fileURLToPath(new URL('../daemon/daemon-entry.js', import.meta.url));
  const daemonScript = existsSync(bundleDaemon) ? bundleDaemon : tscDaemon;
  const daemonEnv = { ...process.env, QUEUE_CONFIG_DIR: configDir };

  if (process.platform === 'win32') {
    // windowsHide:true on spawn is unreliable on Windows — use wscript.exe SW_HIDE
    // which hides the window at Win32 API level regardless of process tree depth.
    const vbsPath = pathJoin(tmpdir(), 'queue-daemon-launch.vbs');
    const safeNode = process.execPath.replace(/"/g, '""');
    const safeDaemon = daemonScript.replace(/"/g, '""');
    const safeConfigDir = configDir.replace(/"/g, '""');
    writeFileSync(vbsPath, [
      'Dim oShell',
      'Set oShell = CreateObject("WScript.Shell")',
      `oShell.Environment("Process")("QUEUE_CONFIG_DIR") = "${safeConfigDir}"`,
      `oShell.Run """${safeNode}"" ""${safeDaemon}""", 0, False`,
    ].join('\r\n'));
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: daemonEnv,
    });
    child.unref();
  } else {
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: daemonEnv,
    });
    child.unref();
  }
}

async function waitForDaemon(configDir: string, timeoutMs = 5000): Promise<boolean> {
  const client = createQueueClient(configDir);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await client.isRunning()) return true;
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
  if (!running) {
    spawnDaemon(configDir);
    const started = await waitForDaemon(configDir, 5000);
    if (!started) {
      process.stderr.write('[queue] Failed to start daemon within 5s\n');
      process.exit(1);
    }
  }
}

function resolveSubsFile(configDir: string, scope: string): string {
  if (scope === 'project') return pathJoin(process.cwd(), '.queue', 'subscribers.yml');
  return pathJoin(configDir, 'subscribers.yml');
}

function readSubsYmlOrExit(filePath: string): { subscribers: Record<string, SubscriberConfig[]> } {
  if (!existsSync(filePath)) return { subscribers: {} };
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

function parseSubFlags(args: string[]): { config: Partial<SubscriberConfig>; errors: string[] } {
  const errors: string[] = [];
  const config: Partial<SubscriberConfig> = {};

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    if (!next || next.startsWith('--')) return undefined;
    return next;
  };

  const typeVal = getArg('--type');
  if (typeVal === 'cli' || typeVal === 'http') config.type = typeVal;
  else if (typeVal) errors.push(`--type must be cli or http, got: ${typeVal}`);

  const commandVal = getArg('--command');
  if (commandVal) config.command = commandVal;

  const urlVal = getArg('--url');
  if (urlVal) config.url = urlVal;

  const methodVal = getArg('--method');
  if (methodVal) config.method = methodVal;

  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--header') {
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        const colonIdx = val.indexOf(':');
        if (colonIdx === -1) {
          errors.push(`Invalid --header format: "${val}" (expected "key:value")`);
        } else {
          headers[val.slice(0, colonIdx).trim()] = val.slice(colonIdx + 1).trim();
        }
      }
    }
  }
  if (Object.keys(headers).length > 0) config.headers = headers;

  const timeoutVal = getArg('--timeout');
  if (timeoutVal) {
    if (!/^\d+(ms|s|m|h)$/.test(timeoutVal)) {
      errors.push(`Invalid timeout: ${timeoutVal} (use e.g. 30s, 5m, 1h)`);
    } else {
      config.timeout = timeoutVal;
    }
  }

  const retriesVal = getArg('--retries');
  if (retriesVal !== undefined) {
    const n = parseInt(retriesVal, 10);
    if (isNaN(n) || n < 0) errors.push(`--retries must be a non-negative integer, got: ${retriesVal}`);
    else config.retries = n;
  }

  const backoffVal = getArg('--backoff');
  if (backoffVal === 'exponential' || backoffVal === 'linear') config.backoff = backoffVal;
  else if (backoffVal) errors.push(`--backoff must be exponential or linear, got: ${backoffVal}`);

  const whenVal = getArg('--when');
  if (whenVal) config.when = whenVal;

  return { config, errors };
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
  const updateManager = new UpdateManager('@wadeck-app/queue-cli');
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
      process.stderr.write('Usage: queue push <event> <json> [--timeout <duration>]\n');
      process.exit(1);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(jsonArg);
    } catch {
      process.stderr.write(`[queue] Invalid JSON payload: ${jsonArg}\n`);
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

    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);

    process.env['QUEUE_PUSH_CWD'] = process.cwd();

    const response = await client.send('push', { event, payload, timeout });

    if (response.status === 'aborted') {
      process.stderr.write(`[queue] Event aborted: ${response.reason ?? 'unknown reason'}\n`);
      process.exit(1);
    }

    if (event.startsWith('before')) {
      process.stdout.write(JSON.stringify(response.result ?? null) + '\n');
    } else {
      process.stdout.write('[ok] queued\n');
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

  if (command === 'status') {
    const jsonFlag = rest.includes('--json');
    const client = createQueueClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (!running) {
      const data = { daemonRunning: false, pendingCount: 0, dlqCount: 0 };
      if (process.stdout.isTTY && !jsonFlag) {
        process.stdout.write('[fail] daemon: not running\n');
        process.stdout.write('       pending: 0\n');
        process.stdout.write('       dlq:     0\n');
      } else {
        process.stdout.write(JSON.stringify(data) + '\n');
      }
      return;
    }
    const response = await client.send('status', undefined);
    const { execFileSync: execFS } = await import('node:child_process');
    let orchAvailable = false;
    try {
      execFS(process.platform === 'win32' ? 'where' : 'which', ['orch'], { stdio: 'pipe', windowsHide: true });
      orchAvailable = true;
    } catch {
      orchAvailable = false;
    }
    const data = { ...response, orchAvailable };
    if (process.stdout.isTTY && !jsonFlag) {
      process.stdout.write('[ok]  daemon:  running\n');
      process.stdout.write(`      pending: ${response.pendingCount}\n`);
      process.stdout.write(`      dlq:     ${response.dlqCount}\n`);
      process.stdout.write(`      orch:    ${orchAvailable ? 'available' : 'not found'}\n`);
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
    const response = await client.send('list-subscribers', { event });
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
      process.stdout.write(JSON.stringify(response.entries, null, 2) + '\n');
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
      process.stdout.write('[ok] daemon already running\n');
      return;
    }
    spawnDaemon(configDir);
    const started = await waitForDaemon(configDir, 5000);
    if (started) {
      process.stdout.write('[ok] daemon started\n');
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

  // Backward-compatible top-level alias for `queue cli logs`
  if (command === 'logs') {
    await cliLogsCommand(configDir, { follow: rest.includes('--follow') || rest.includes('-f') });
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
          if (!daemonRunning) return { name: 'daemon', ok: true, detail: 'not running (skipped)' };
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
          if (!existsSync(portFile)) return { name: 'port-file', ok: true, detail: 'absent (skipped)' };
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
      await cliLogsCommand(configDir, { follow: subArgs.includes('--follow') || subArgs.includes('-f') });
      return;
    }

    if (sub === 'version') {
      warnUnknownArgs(rest.slice(1), [], 'queue cli version');
      const channel = readChannelFromConfig(configDir);
      await cliVersionCommand('@wadeck-app/queue-cli', VERSION, channel);
      return;
    }

    if (sub === 'update') {
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
        const response = await client.send('list-subscribers', { event: eventArg });
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
        if (eventArg && evtPattern !== eventArg) continue;
        for (let i = 0; i < subs.length; i++) {
          const s = subs[i]!;
          entries.push({ subscriberId: `${evtPattern}[${i}]`, event: evtPattern, type: s.type, command: s.command, url: s.url });
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
      if (config.type === 'cli' && !config.command) {
        process.stderr.write(`[fail] --command is required for type: cli\n`);
        process.exit(1);
      }
      if (config.type === 'http' && !config.url) {
        process.stderr.write(`[fail] --url is required for type: http\n`);
        process.exit(1);
      }

      const filePath = resolveSubsFile(configDir, scope);
      if (scope === 'project') mkdirSync(pathJoin(process.cwd(), '.queue'), { recursive: true });
      const data = readSubsYmlOrExit(filePath);
      const existing = data.subscribers[event] ?? [];
      const newEntry: SubscriberConfig = { type: config.type };
      if (config.command) newEntry.command = config.command;
      if (config.url) newEntry.url = config.url;
      if (config.method) newEntry.method = config.method;
      if (config.headers && Object.keys(config.headers).length > 0) newEntry.headers = config.headers;
      if (config.timeout) newEntry.timeout = config.timeout;
      if (config.retries !== undefined) newEntry.retries = config.retries;
      if (config.backoff) newEntry.backoff = config.backoff;
      if (config.when) newEntry.when = config.when;
      data.subscribers[event] = [...existing, newEntry];
      writeSubsYmlOrExit(filePath, data);
      process.stdout.write(`[ok] Added subscriber to '${event}' (index ${existing.length}) in ${filePath}\n`);
      return;
    }

    if (sub === 'remove') {
      const indexIdx = rest.indexOf('--index');
      const indexStr = indexIdx !== -1 ? rest[indexIdx + 1] : undefined;
      if (!indexStr) {
        process.stderr.write(`[fail] --index <N> is required\n`);
        process.exit(1);
      }
      const index = parseInt(indexStr, 10);
      if (isNaN(index) || index < 0) {
        process.stderr.write(`[fail] --index must be a non-negative integer\n`);
        process.exit(1);
      }
      const filePath = resolveSubsFile(configDir, scope);
      if (!existsSync(filePath)) {
        process.stderr.write(`[fail] No subscribers file at: ${filePath}\n`);
        process.exit(1);
      }
      const data = readSubsYmlOrExit(filePath);
      const subs = data.subscribers[event] ?? [];
      if (index >= subs.length) {
        process.stderr.write(`[fail] No subscriber at index ${index} for event '${event}' (found ${subs.length})\n`);
        process.exit(1);
      }
      data.subscribers[event] = subs.filter((_, i) => i !== index);
      if (data.subscribers[event]!.length === 0) delete data.subscribers[event];
      writeSubsYmlOrExit(filePath, data);
      process.stdout.write(`[ok] Removed subscriber at index ${index} from '${event}' in ${filePath}\n`);
      return;
    }

    if (sub === 'edit') {
      const indexIdx = rest.indexOf('--index');
      const indexStr = indexIdx !== -1 ? rest[indexIdx + 1] : undefined;
      if (!indexStr) {
        process.stderr.write(`[fail] --index <N> is required\n`);
        process.exit(1);
      }
      const index = parseInt(indexStr, 10);
      if (isNaN(index) || index < 0) {
        process.stderr.write(`[fail] --index must be a non-negative integer\n`);
        process.exit(1);
      }
      const filePath = resolveSubsFile(configDir, scope);
      if (!existsSync(filePath)) {
        process.stderr.write(`[fail] No subscribers file at: ${filePath}\n`);
        process.exit(1);
      }
      const data = readSubsYmlOrExit(filePath);
      const subs = data.subscribers[event] ?? [];
      if (index >= subs.length) {
        process.stderr.write(`[fail] No subscriber at index ${index} for event '${event}' (found ${subs.length})\n`);
        process.exit(1);
      }
      const { config, errors } = parseSubFlags(rest.slice(2));
      if (errors.length > 0) {
        for (const e of errors) process.stderr.write(`[fail] ${e}\n`);
        process.exit(1);
      }
      if (!config.type) {
        process.stderr.write(`[fail] --type cli|http is required\nUsage: queue sub edit <event> --index <N> --type cli|http ...\n`);
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
      const newEntry: SubscriberConfig = { type: config.type };
      if (config.command) newEntry.command = config.command;
      if (config.url) newEntry.url = config.url;
      if (config.method) newEntry.method = config.method;
      if (config.headers && Object.keys(config.headers).length > 0) newEntry.headers = config.headers;
      if (config.timeout) newEntry.timeout = config.timeout;
      if (config.retries !== undefined) newEntry.retries = config.retries;
      if (config.backoff) newEntry.backoff = config.backoff;
      if (config.when) newEntry.when = config.when;
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
    updateManager.scheduleBackgroundUpdate(bundlePath, 'queue-updater.cjs');
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
