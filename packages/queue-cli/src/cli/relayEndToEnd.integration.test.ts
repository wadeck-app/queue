import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'node:net';
import { spawnOwned, waitFor, withHangGuard } from '../testWaitFor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const bundlePath = join(rootDir, 'dist-bundle/queue.cjs');

let tempConfigDir: string;
let portsBusy: boolean = false;

// A removal that survives Windows holding a file for a moment after a child process exited (EPERM, EBUSY): Node retries it
const removeDir = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// Helper to check if a port is listening
async function isPortListening(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

// Helper to wait for a port to become free
async function waitForPortFree(port: number): Promise<void> {
  await waitFor(async () => !(await isPortListening(port)), `port ${port} to become free`);
}

// Helper to check if process is still running (works on Windows and Unix)
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  // Build the bundle before running integration tests
  execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
    windowsHide: true,
  });

  tempConfigDir = mkdtempSync(join(tmpdir(), 'queue-relay-e2e-'));

  // Check if critical ports are already in use (MUST be done in beforeAll)
  const daemonInUse = await isPortListening(47910);
  const relayInUse = await isPortListening(47911);
  portsBusy = daemonInUse || relayInUse;
});

afterAll(() => {
  if (tempConfigDir && existsSync(tempConfigDir)) {
    removeDir(tempConfigDir);
  }
});

function runCli(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf-8',
    // Hang guard only, never a performance limit
    timeout: 300_000,
    env: {
      ...process.env,
      QUEUE_CONFIG_DIR: tempConfigDir,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

interface HistoryPage {
  entries: Array<{
    event: string;
    payload?: { repository?: { full_name?: string } };
    cwd?: string;
  }>;
}

function readHistory(): HistoryPage {
  const { stdout, exitCode, stderr } = runCli(['history', '--json']);
  expect(exitCode, `history failed: ${stderr}`).toBe(0);
  return JSON.parse(stdout) as HistoryPage;
}

describe('relay end-to-end (integration)', () => {
  it(
    'relay start connects to ws server, filters events via plugin subscription, and records logs',
    async (ctx) => {
      // Skip if ports are already in use (proper skip report, not silent pass)
      if (portsBusy) {
        ctx.skip();
      }

      // Step 1: Create mock WebSocket server on a random port
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      let wsPort: number = 0;
      let subscribeFilter: unknown = null;
      let relayConnected = false;

      const server = await new Promise<WebSocketServer>((resolve, reject) => {
        wss.once('listening', () => {
          // Use properly typed address() method (no private fields)
          const addr = wss.address();
          if (typeof addr === 'object' && addr?.port) {
            wsPort = addr.port;
            resolve(wss);
          } else {
            reject(new Error('Could not determine WebSocket server port'));
          }
        });
        wss.on('error', reject);
      });

      wss.on('connection', (ws: WebSocket) => {
        relayConnected = true;
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString('utf-8'));
          if (msg.type === 'auth') {
            ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
          } else if (msg.type === 'subscribe') {
            subscribeFilter = msg.filter;
            ws.send(JSON.stringify({ type: 'subscribed', filter: msg.filter }));
            // A WebSocket delivers messages in order: the matching event, then the non-matching one. Once the relay has logged the
            // second as unmatched, it is done with the first (this is the barrier for the "exactly one entry" assertion below).
            ws.send(
              JSON.stringify({
                type: 'event',
                envelope: {
                  source: 'github',
                  webhookConfigId: 'w1',
                  eventType: 'push',
                  deliveryId: 'd-match',
                  receivedAt: new Date().toISOString(),
                  payload: { ref: 'refs/heads/main', repository: { full_name: 'o/r' } },
                },
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                envelope: {
                  source: 'github',
                  webhookConfigId: 'w1',
                  eventType: 'push',
                  deliveryId: 'd-other',
                  receivedAt: new Date().toISOString(),
                  payload: { ref: 'refs/heads/main', repository: { full_name: 'other/repo' } },
                },
              }),
            );
          }
        });
      });

      let relayDaemonPid: number | null = null;
      let queueDaemonPid: number | null = null;

      try {
        // Pre-cleanup: Stop any existing relay/queue daemons from previous runs
        runCli(['relay', 'stop']);
        runCli(['stop']);
        // Wait until both daemons really released their ports
        await waitForPortFree(47910);
        await waitForPortFree(47911);

        // Step 2: Write relay.yml with mock WebSocket URL
        const relayYmlPath = join(tempConfigDir, 'relay.yml');
        writeFileSync(
          relayYmlPath,
          `relayUrl: ws://127.0.0.1:${wsPort}/relay-ws
token: t
plugins:
  - module: '@wadeck-app/plugin-github'
    subscriptions:
      - eventType: [push]
        payloadMatch: { 'repository.full_name': 'o/r' }
`,
          'utf-8',
        );

        // Step 3: Run 'relay start' and assert exit 0
        const relayStart = runCli(['relay', 'start']);
        expect(relayStart.exitCode, `relay start failed: ${relayStart.stderr}`).toBe(0);
        expect(relayStart.stdout).toContain('relay client started');

        // Wait for relay to connect and subscribe
        await waitFor(() => relayConnected && subscribeFilter !== null, 'the relay to connect to the WebSocket server and subscribe');

        // Get relay daemon PID for later process exit check
        const relayStatusResult = runCli(['relay', 'status', '--json']);
        expect(relayStatusResult.exitCode).toBe(0);
        const relayStatus = JSON.parse(relayStatusResult.stdout) as {
          pid?: number;
          relayRunning?: boolean;
        };
        relayDaemonPid = relayStatus.pid ?? null;

        // Get queue daemon PID if it was started
        const queueStatusResult = runCli(['status', '--json']);
        if (queueStatusResult.exitCode === 0) {
          const queueStatus = JSON.parse(queueStatusResult.stdout) as { pid?: number };
          queueDaemonPid = queueStatus.pid ?? null;
        }

        // Step 4: Wait for the relay to have handled BOTH events: the non-matching one is logged, and it was sent after the matching one
        const relayLogPath = join(tempConfigDir, 'relay-daemon', 'relay.log');
        await waitFor(() => existsSync(relayLogPath) && readFileSync(relayLogPath, 'utf-8').includes('d-other'),
          `the relay log to mention the non-matching delivery d-other (${relayLogPath})`);

        // The matching event must reach the history: wait for it
        const matchingEntry = await waitFor(() => readHistory().entries.find((e) => e.event === 'on.github.push'),
          "the 'on.github.push' entry in the history");

        // Exactly one entry: the non-matching delivery (handled after it) did not produce another
        const allMatching = readHistory().entries.filter((e) => e.event === 'on.github.push');
        expect(allMatching).toHaveLength(1);

        // Assert payload and cwd
        expect(matchingEntry.payload?.repository?.full_name).toBe('o/r');
        const normalizedEntryCwd = matchingEntry.cwd?.toLowerCase().replace(/\\/g, '/');
        const normalizedTempCwd = tempConfigDir.toLowerCase().replace(/\\/g, '/');
        expect(normalizedEntryCwd).toBe(normalizedTempCwd);

        // Step 5: Assert filter deep-equals expected
        expect(subscribeFilter).toEqual({
          source: 'github',
          eventType: ['push'],
          payloadMatch: {},
        });

        // Step 6: Assert relay.log exists and contains expected messages
        expect(existsSync(relayLogPath), `Relay log not found at ${relayLogPath}`).toBe(true);
        const logContent = readFileSync(relayLogPath, 'utf-8');
        expect(logContent).toContain('matched no subscription');
        expect(logContent).toContain('d-other');

        // Step 7: Assert 'relay status' JSON before stopping
        const { stdout: statusOut } = runCli(['relay', 'status', '--json']);
        const status = JSON.parse(statusOut) as {
          relayRunning: boolean;
          connected: boolean;
          lastError: unknown;
          pid?: number;
        };
        expect(status.relayRunning).toBe(true);
        expect(status.connected).toBe(true);
        expect(status.lastError).toBeNull();
        if (status.pid) {
          relayDaemonPid = status.pid;
        }
      } finally {
        // Step 8: Guaranteed cleanup in finally block (regardless of assertion failures)
        try {
          // Stop relay
          runCli(['relay', 'stop']);

          // Stop queue daemon
          runCli(['stop']);

          // Close WebSocket server
          server.close();

          // Wait for the ports to become free (a hang is reported by the waiter, naming the port)
          await waitForPortFree(47910);
          await waitForPortFree(47911);

          // Step 9: Verify relay process actually exited
          if (relayDaemonPid !== null) {
            const pid = relayDaemonPid;
            await waitFor(() => !isProcessRunning(pid),
              `relay process ${pid} to exit after relay stop (RelayDaemon.ts needs hooks.onShutdown)`);
          }

          // Step 10: Verify queue daemon process exited if one was started
          if (queueDaemonPid !== null) {
            const pid = queueDaemonPid;
            await waitFor(() => !isProcessRunning(pid), `queue daemon process ${pid} to exit after stop`);
          }
        } finally {
          // Ensure temp dir is removed, with retry for file locks on Windows (throws if still locked: the lock issue must be visible)
          if (tempConfigDir && existsSync(tempConfigDir)) {
            removeDir(tempConfigDir);
          }
        }
      }
    },
  );
});

describe('relay daemon bundle smoke test (integration)', () => {
  it('the bundled relay daemon runs alone from an empty directory, loads the built-in github plugin and subscribes', async (ctx) => {
    if (await isPortListening(47911)) {
      ctx.skip();
      return;
    }

    const relayBundle = join(rootDir, 'dist-bundle/queue-relay-daemon.cjs');
    expect(existsSync(relayBundle), `Bundle not found: ${relayBundle}`).toBe(true);

    // The copy lives in a fresh directory with no node_modules above it: it must be self-contained
    const isolatedDir = mkdtempSync(join(tmpdir(), 'queue-relay-bundle-smoke-'));
    const configDir = mkdtempSync(join(tmpdir(), 'queue-relay-config-smoke-'));
    const received: Array<{ type: string; filter?: unknown }> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let daemon: ReturnType<typeof spawnOwned> | undefined;
    let exitCode: number | null | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        wss.once('listening', () => resolve());
        wss.once('error', reject);
      });
      const { port } = wss.address() as net.AddressInfo;
      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as { type: string; filter?: unknown };
          received.push(message);
          if (message.type === 'auth') {
            ws.send(JSON.stringify({ type: 'authenticated', username: 'smoke' }));
          }
        });
      });

      const bundleCopy = join(isolatedDir, 'queue-relay-daemon.cjs');
      copyFileSync(relayBundle, bundleCopy);
      writeFileSync(
        join(configDir, 'relay.yml'),
        `relayUrl: ws://127.0.0.1:${port}/relay-ws\ntoken: smoke\nplugins:\n  - module: '@wadeck-app/plugin-github'\n    subscriptions:\n      - eventType: [push]\n`,
        'utf-8',
      );

      daemon = spawnOwned(process.execPath, [bundleCopy], {
        cwd: isolatedDir,
        env: { ...process.env, QUEUE_CONFIG_DIR: configDir, NODE_PATH: '' },
      });
      void daemon.exited.then((code) => { exitCode = code; });

      // Either the daemon subscribes (success) or it exits (the assertions below then report why)
      await waitFor(() => exitCode !== undefined || received.some((m) => m.type === 'subscribe'), 'the relay daemon to subscribe (or exit)');

      expect(exitCode, `relay daemon exited early with code ${exitCode}; stderr: ${daemon.stderr()}`).toBeUndefined();
      const subscribe = received.find((m) => m.type === 'subscribe');
      expect(subscribe?.filter, `no subscribe received; stderr: ${daemon.stderr()}`).toEqual({
        source: 'github',
        eventType: ['push'],
        payloadMatch: {},
      });
    } finally {
      if (daemon && daemon.child.exitCode === null) {
        daemon.child.kill();
        await withHangGuard(daemon.exited, 'the killed relay daemon to exit');
      }
      wss.close();
      removeDir(isolatedDir);
      removeDir(configDir);
    }
  });
});
