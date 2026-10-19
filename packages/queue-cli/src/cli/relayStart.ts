import { getErrorMessage } from '@wadeck-app/queue-core';
import { join } from 'node:path';
import type { RelayStopIO } from './relayStop.js';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import type { RelayCommands, RelayConfig } from '@wadeck-app/queue-relay-client';

export interface RelayStartDeps {
  client: DaemonClient<RelayCommands>;
  loadConfig: (configDir: string) => (RelayConfig & { tokenSource?: 'env' | 'secrets' | 'relay.yml' }) | null;
  resolveDaemonScript: () => string;
  getQueueDaemonScript: () => string;
  spawn: (script: string, configDir: string, env: Record<string, string>) => void;
  waitForDaemon: (ms: number) => Promise<boolean>;
  readLogTail: (path: string, lines: number) => string[] | null;
  io: RelayStopIO;
}

/**
 * Start the relay client with comprehensive validation and error reporting.
 * Validates config before spawning, reports actionable errors at each step.
 *
 * Outcomes:
 * (a) Already running -> [ok] relay client already running, exit 0
 * (b) No relay.yml -> [fail] with helpful template, exit 1
 * (c) Invalid relay.yml -> [fail] with validation error, exit 1
 * (d) Zero plugins -> [fail] with instruction, exit 1
 * (e) Daemon script not found -> [fail] with known gap message, exit 1
 * (f) Spawn and wait succeeds -> [ok] relay client started, exit 0
 * (g) Timeout -> [fail] with last log lines or foreground hint, exit 1
 */
export async function relayStart(deps: RelayStartDeps, configDir: string): Promise<number> {
  // Check if relay is already running (idempotent case a)
  const isRunning = await deps.client.isRunning().catch(() => false);
  if (isRunning) {
    deps.io.stderr.write('[ok] relay client already running\n');
    return 0;
  }

  // Load and validate relay.yml (cases b, c, d)
  let config;
  try {
    config = deps.loadConfig(configDir);
  } catch (err) {
    // Validation error: invalid YAML or schema violation (case c)
    const errorMsg = getErrorMessage(err);
    deps.io.stderr.write(`[fail] ${errorMsg}\n`);
    return 1;
  }

  if (config === null) {
    // Missing relay.yml (case b)
    deps.io.stderr.write(`[fail] No relay.yml in ${configDir}. Create it as:\n`);
    deps.io.stderr.write(`  relayUrl: wss://<relay-host>/relay-ws\n`);
    deps.io.stderr.write(`  plugins:\n`);
    deps.io.stderr.write(`    - module: '@wadeck-app/plugin-github'\n`);
    deps.io.stderr.write(`      subscriptions:\n`);
    // payloadMatch is a flat top-level equality check today (the relay does not resolve dotted paths)
    deps.io.stderr.write(`        - eventType: [push, pull_request]\n`);
    deps.io.stderr.write(`          payloadMatch: { action: opened }\n`);
    deps.io.stderr.write(`\nThe relay token is stored in <QUEUE_CONFIG_DIR>/_secrets_/.env.local:\n`);
    deps.io.stderr.write(`  QUEUE_RELAY_TOKEN=<your-relay-consumer-token>\n`);
    deps.io.stderr.write(`See 'queue relay --help' for more details.\n`);
    return 1;
  }

  // Warn if token is from relay.yml (deprecated)
  if (config.tokenSource === 'relay.yml') {
    deps.io.stderr.write(
      `[warn] The relay token is read from relay.yml (plaintext). ` +
      `Move it to ${configDir}/_secrets_/.env.local as QUEUE_RELAY_TOKEN=... and remove it from relay.yml.\n`
    );
  }

  if (config.plugins.length === 0) {
    // No plugins configured (case d)
    const relayYmlPath = join(configDir, 'relay.yml');
    deps.io.stderr.write(`[fail] relay.yml has no plugins configured (${relayYmlPath}).\n`);
    return 1;
  }

  // Resolve relay daemon script (case e)
  let daemonScript: string;
  let queueDaemonScript: string;
  try {
    daemonScript = deps.resolveDaemonScript();
    queueDaemonScript = deps.getQueueDaemonScript();
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    deps.io.stderr.write(`[fail] The relay daemon script was not found (${errorMsg}).\n`);
    deps.io.stderr.write(`Reinstall or update the queue CLI ('queue cli update'), or use a development build of the queue repo.\n`);
    return 1;
  }

  // Spawn daemon and wait (case f, g)
  // violations-suppress: cli/no-spawn-without-windows-hide deps.spawn is the injected spawnDetachedProcess, which hides the window
  deps.spawn(daemonScript, configDir, { QUEUE_DAEMON_SCRIPT: queueDaemonScript });
  const started = await deps.waitForDaemon(5000);

  if (started) {
    // Success case (f)
    deps.io.stdout.write('[ok] relay client started\n');
    return 0;
  }

  // Timeout case (g)
  const logPath = join(configDir, 'relay-daemon', 'relay.log');
  deps.io.stderr.write('[fail] relay client failed to start within 5s.\n');

  const logLines = deps.readLogTail(logPath, 5);
  if (logLines !== null) {
    deps.io.stderr.write('Log output:\n');
    for (const line of logLines) {
      deps.io.stderr.write(`  | ${line}\n`);
    }
    deps.io.stderr.write(`Full log: ${logPath}\n`);
  } else {
    deps.io.stderr.write('No log was written: the process died before logging.\n');
    deps.io.stderr.write('Run it in the foreground to see the error:\n');
    deps.io.stderr.write(`  QUEUE_CONFIG_DIR=${configDir} node ${daemonScript}\n`);
  }

  return 1;
}
