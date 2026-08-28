#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ConfigDir } from '@wadeck/shared-cli/ConfigDir';
import { UpdateManager } from '@wadeck/shared-cli/UpdateManager';
import { createQueueClient } from './QueueClient.js';

declare const __QUEUE_CLI_VERSION__: string;

const VERSION = typeof __QUEUE_CLI_VERSION__ !== 'undefined' ? __QUEUE_CLI_VERSION__ : '0.1.0-dev';

function usage(): void {
  process.stdout.write(`queue v${VERSION}
Usage:
  queue push <event> <json> [--timeout <duration>]
  queue retry --event <id>
  queue status
  queue list-subscribers [event]
  queue dlq list
  queue dlq replay --id <id>
  queue dlq clear [--id <id>]
  queue start
  queue stop
  queue logs [--follow]
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Read and display any pending update notification before command output.
  const updateManager = new UpdateManager('@wadeck/queue-cli');
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
      process.stdout.write('queued\n');
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
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  if (command === 'status') {
    const client = createQueueClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (!running) {
      process.stdout.write(JSON.stringify({ daemonRunning: false, pendingCount: 0, dlqCount: 0 }) + '\n');
      return;
    }
    const response = await client.send('status', undefined);
    const { execFileSync } = await import('node:child_process');
    let orchAvailable = false;
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', ['orch'], { stdio: 'pipe' });
      orchAvailable = true;
    } catch {
      orchAvailable = false;
    }
    process.stdout.write(JSON.stringify({ ...response, orchAvailable }) + '\n');
    return;
  }

  if (command === 'list-subscribers') {
    const event = rest[0];
    await ensureDaemon(configDir);
    const client = createQueueClient(configDir);
    const response = await client.send('list-subscribers', { event });
    process.stdout.write(JSON.stringify(response.subscribers, null, 2) + '\n');
    return;
  }

  if (command === 'dlq') {
    const sub = rest[0];

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
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    if (sub === 'clear') {
      const idIdx = rest.indexOf('--id');
      const id = idIdx !== -1 ? rest[idIdx + 1] : undefined;
      await ensureDaemon(configDir);
      const client = createQueueClient(configDir);
      const response = await client.send('dlq-clear', { id });
      process.stdout.write(`Cleared ${response.cleared} entries\n`);
      return;
    }

    process.stderr.write(`Unknown dlq subcommand: ${sub ?? '(none)'}\nUse: queue dlq list|replay|clear\n`);
    process.exit(1);
  }

  if (command === 'start') {
    const client = createQueueClient(configDir);
    const running = await client.isRunning().catch(() => false);
    if (running) {
      process.stdout.write('Daemon already running\n');
      return;
    }
    spawnDaemon(configDir);
    const started = await waitForDaemon(configDir, 5000);
    if (started) {
      process.stdout.write('Daemon started\n');
    } else {
      process.stderr.write('[queue] Daemon failed to start within 5s\n');
      process.exit(1);
    }
    return;
  }

  if (command === 'stop') {
    const client = createQueueClient(configDir);
    try {
      // 'quit' is a built-in daemon command; cast to bypass typing
      await (client.send as (cmd: string, payload?: unknown) => Promise<unknown>)('quit', undefined);
      process.stdout.write('Daemon stopped\n');
    } catch {
      process.stderr.write('[queue] Daemon not running or failed to stop\n');
    }
    return;
  }

  if (command === 'logs') {
    const follow = rest.includes('--follow');
    const { join: pathJoin } = await import('node:path');
    const { existsSync, readFileSync: readFS, watch } = await import('node:fs');

    const logsDir = pathJoin(configDir, 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const logFile = pathJoin(logsDir, `${today}.ndjson`);

    if (existsSync(logFile)) {
      process.stdout.write(readFS(logFile, 'utf-8'));
    }

    if (follow) {
      process.stdout.write(`[queue] Following ${logFile} (Ctrl+C to stop)\n`);
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
    return;
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
