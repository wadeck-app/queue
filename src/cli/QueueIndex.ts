#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
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

function parseDurationMs(raw: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h)$/.exec(raw);
  if (!match) return undefined;
  const val = parseInt(match[1]!, 10);
  switch (match[2]) {
    case 'ms': return val;
    case 's': return val * 1000;
    case 'm': return val * 60_000;
    case 'h': return val * 3_600_000;
    default: return undefined;
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

async function runLogsCommand(configDir: string, rest: string[]): Promise<void> {
  const follow = rest.includes('--follow') || rest.includes('-f');
  const { existsSync, readFileSync: readFS, watch } = await import('node:fs');

  const logsDir = pathJoin(configDir, 'logs');
  const today = new Date().toISOString().slice(0, 10);
  const logFile = pathJoin(logsDir, `${today}.ndjson`);

  if (existsSync(logFile)) {
    process.stdout.write(readFS(logFile, 'utf-8'));
  }

  if (follow) {
    // Informational prefix goes to stderr to avoid polluting log output piped to tools
    process.stderr.write(`[queue] Following ${logFile} (Ctrl+C to stop)\n`);
    let size = existsSync(logFile) ? readFS(logFile, 'utf-8').length : 0;
    watch(logFile, { persistent: true }, () => {
      if (existsSync(logFile)) {
        const content = readFS(logFile, 'utf-8');
        if (content.length > size) {
          process.stdout.write(content.slice(size));
          size = content.length;
        }
      }
    });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Log every CLI invocation to ~/.config/queue/logs/YYYY-MM-DD.ndjson
  try {
    const logsDir = pathJoin(getConfigDir(), 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const logFile = pathJoin(logsDir, `${today}.ndjson`);
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `cmd: queue ${args.join(' ')}` }) + '\n');
  } catch { /* never block the CLI on logging failure */ }

  // Read and display any pending update notification before command output.
  const updateManager = new UpdateManager('@wadeck-app/queue-cli');
  const updateState = updateManager.readAndClearState();
  if (updateState) {
    if (updateState.status === 'success') {
      process.stderr.write(`[queue] Updated to v${updateState.newVersion ?? '?'}\n`);
    } else if (updateState.status === 'rolled-back') {
      process.stderr.write(`[queue] Update to v${updateState.targetVersion ?? '?'} failed (self-check), rolled back to v${updateState.previousVersion ?? '?'}\n`);
    } else if (updateState.status === 'update-failed') {
      process.stderr.write(`[queue] Background update failed: ${updateState.reason ?? 'unknown'}\n`);
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
      timeout = parseDurationMs(rest[timeoutIdx + 1]!);
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
    await runLogsCommand(configDir, rest);
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

      // Check (a): bundle version is a real version, not the literal string 'undefined'
      const versionOk = VERSION !== 'undefined' && !VERSION.startsWith('0.0.0-dev');
      if (!quiet) {
        const line = versionOk
          ? `[ok]  version: ${VERSION}\n`
          : `[fail] version: resolved to ${VERSION} (bundle may not be built)\n`;
        process.stderr.write(line);
      }
      if (!versionOk) allOk = false;

      // Check (b): config dir is writable
      const writableOk = isConfigDirWritable(configDir);
      if (!quiet) {
        const line = writableOk
          ? `[ok]  config-dir: ${configDir}\n`
          : `[fail] config-dir: ${configDir} is not writable\n`;
        process.stderr.write(line);
      }
      if (!writableOk) allOk = false;

      // Check (c): daemon client can be instantiated without connecting
      let clientOk = false;
      let clientErr = '';
      try {
        createQueueClient(configDir);
        clientOk = true;
      } catch (e: unknown) {
        clientErr = e instanceof Error ? e.message : String(e);
      }
      if (!quiet) {
        const line = clientOk
          ? '[ok]  daemon-client: instantiable\n'
          : `[fail] daemon-client: ${clientErr}\n`;
        process.stderr.write(line);
      }
      if (!clientOk) allOk = false;

      process.exit(allOk ? 0 : 1);
      return;
    }

    if (sub === 'logs') {
      await runLogsCommand(configDir, rest.slice(1));
      return;
    }

    if (sub === 'version') {
      process.stdout.write(`queue v${VERSION} (installed)\n`);
      try {
        const { existsSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        const NPM_CLI = pathJoin(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const USE_CLI = existsSync(NPM_CLI);
        const winHide = process.platform === 'win32' ? { windowsHide: true as const } : {};
        const result = USE_CLI
          ? execFileSync(process.execPath, [NPM_CLI, 'view', '@wadeck-app/queue-cli', 'dist-tags.latest'], { encoding: 'utf8', timeout: 15000, ...winHide })
          : execFileSync('npm', ['view', '@wadeck-app/queue-cli', 'dist-tags.latest'], { encoding: 'utf8', timeout: 15000, ...winHide });
        const latest = result.trim();
        process.stdout.write(`Latest (latest): v${latest}\n`);
        if (VERSION === latest) process.stdout.write('Up to date.\n');
      } catch (err) {
        process.stderr.write(`Could not fetch latest version: ${String(err)}\n`);
      }
      return;
    }

    if (sub === 'update') {
      // Find queue-updater.cjs next to the bundle file
      const { dirname } = await import('node:path');
      const bundleDir = dirname(bundlePath);
      const updaterPath = pathJoin(bundleDir, 'queue-updater.cjs');
      const { existsSync } = await import('node:fs');
      if (!existsSync(updaterPath)) {
        process.stderr.write(`[fail] updater not found at: ${updaterPath}\n`);
        process.exit(1);
      }
      process.stderr.write('[queue] Running update (this may take a moment)...\n');
      try {
        execFileSync(process.execPath, [updaterPath], {
          stdio: 'inherit',
          env: { ...process.env, UPDATER_FORCE: '1' },
        });
        process.stdout.write('[ok] update completed\n');
      } catch {
        process.stderr.write('[fail] update failed\n');
        process.exit(1);
      }
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
