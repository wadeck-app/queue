#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { parseDuration } from '@wadeck-app/shared-cli/Duration';
import { logCliInvocation } from '@wadeck-app/shared-cli/CliLogger';
import { cliLogsCommand, cliVersionCommand, cliUpdateCommand, warnUnknownArgs } from '@wadeck-app/shared-cli/CliMetaCommands';
import { readChannelFromConfig } from '@wadeck-app/shared-cli/ChannelConfig';
import { createQueueClient } from './QueueClient.js';

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
  const daemonScript = fileURLToPath(new URL('../daemon/daemon-entry.js', import.meta.url));
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, QUEUE_CONFIG_DIR: configDir },
  });
  child.unref();
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
      execFS(process.platform === 'win32' ? 'where' : 'which', ['orch'], { stdio: 'pipe' });
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
      const quiet = process.env['CLI_SELF_CHECK_QUIET'] === '1';
      let allOk = true;

      function report(ok: boolean, msg: string): void {
        if (!quiet) process.stderr.write(`${ok ? '[ok] ' : '[fail]'} ${msg}\n`);
        if (!ok) allOk = false;
      }

      // (a) Bundle version is a real version, not the dev placeholder
      report(
        VERSION !== 'undefined' && !VERSION.startsWith('0.0.0-dev'),
        `version: ${VERSION}`,
      );

      // (b) Config dir is writable
      report(isConfigDirWritable(configDir), `config-dir: ${configDir}`);

      // (c) If daemon is running, ping it and verify it responds with a valid version
      const client = createQueueClient(configDir);
      let daemonRunning = false;
      try {
        daemonRunning = await client.isRunning();
      } catch { /* not running */ }

      if (daemonRunning) {
        let pingOk = false;
        let pingErr = '';
        try {
          const info = await client.version();
          pingOk = typeof info?.version === 'string' && info.version.length > 0;
          if (!pingOk) pingErr = `unexpected version response: ${JSON.stringify(info)}`;
        } catch (e: unknown) {
          pingErr = e instanceof Error ? e.message : String(e);
        }
        report(pingOk, pingOk ? `daemon: running, v${(await client.version()).version}` : `daemon ping failed: ${pingErr}`);
      } else {
        if (!quiet) process.stderr.write('[info] daemon: not running (skipping ping)\n');
      }

      // (d) If port file exists, verify it has expected fields
      const portFile = pathJoin(configDir, 'config.port');
      const { existsSync, readFileSync } = await import('node:fs');
      if (existsSync(portFile)) {
        let portOk = false;
        let portErr = '';
        try {
          const data = JSON.parse(readFileSync(portFile, 'utf8'));
          portOk = typeof data?.port === 'number' && typeof data?.pid === 'number';
          if (!portOk) portErr = 'missing port or pid fields';
        } catch (e: unknown) {
          portErr = e instanceof Error ? e.message : String(e);
        }
        report(portOk, portOk ? `port-file: port valid` : `port-file corrupt: ${portErr}`);
      }

      process.exit(allOk ? 0 : 1);
      return;
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
    process.stderr.write(`[queue] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { main as runQueueCommand };
