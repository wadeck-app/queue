import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const bundlePath = join(rootDir, 'dist-bundle/queue.cjs');

let tempConfigDir: string;
let portsBusy: boolean = false;

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
async function waitForPortFree(port: number, maxWaitMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (!(await isPortListening(port))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
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
    timeout: 60_000,
    windowsHide: true,
  });

  tempConfigDir = mkdtempSync(join(tmpdir(), 'queue-relay-e2e-'));

  // Check if critical ports are already in use (MUST be done in beforeAll)
  const daemonInUse = await isPortListening(47910);
  const relayInUse = await isPortListening(47911);
  portsBusy = daemonInUse || relayInUse;
}, 90_000);

afterAll(() => {
  if (tempConfigDir && existsSync(tempConfigDir)) {
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

function runCli(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
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

describe('relay end-to-end (integration)', () => {
  it(
    'relay start connects to ws server, filters events via plugin subscription, and records logs',
    async (ctx) => {
      // Skip if ports are already in use (proper skip report, not silent pass)
      if (portsBusy) {
        ctx.skip();
      }

      const testStartTime = Date.now();

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
        setTimeout(() => reject(new Error('WebSocket server failed to start')), 5000);
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
            // Send matching event after 300ms
            setTimeout(() => {
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
            }, 300);
            // Send non-matching event after 1500ms
            setTimeout(() => {
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
            }, 1500);
          }
        });
      });

      let relayDaemonPid: number | null = null;
      let queueDaemonPid: number | null = null;

      try {
        // Pre-cleanup: Stop any existing relay/queue daemons from previous runs
        runCli(['relay', 'stop']);
        runCli(['stop']);
        // Give daemons time to shut down
        await new Promise((r) => setTimeout(r, 500));

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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(relayConnected, 'Relay did not connect to WebSocket server').toBe(true);

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

        // Step 4: Poll 'history --json' until matching event appears
        let historyFound = false;
        const pollStart = Date.now();
        const maxWait = 20_000;

        while (Date.now() - pollStart < maxWait) {
          const { stdout, exitCode } = runCli(['history', '--json']);
          expect(exitCode).toBe(0);

          const page = JSON.parse(stdout) as {
            entries: Array<{
              event: string;
              payload?: Record<string, any>;
              cwd?: string;
            }>;
            total: number;
            limit: number;
            offset: number;
          };

          const matchingEntry = page.entries.find((e) => e.event === 'on.github.push');
          if (matchingEntry) {
            historyFound = true;
            // Assert exactly one entry after 3 more seconds (negative assertion window)
            await new Promise((r) => setTimeout(r, 3000));

            const { stdout: finalStdout } = runCli(['history', '--json']);
            const finalPage = JSON.parse(finalStdout) as { entries: Array<{ event: string }> };
            const allMatching = finalPage.entries.filter((e) => e.event === 'on.github.push');
            expect(allMatching).toHaveLength(1);

            // Assert payload and cwd
            expect(matchingEntry.payload?.repository?.full_name).toBe('o/r');
            const normalizedEntryCwd = matchingEntry.cwd?.toLowerCase().replace(/\\/g, '/');
            const normalizedTempCwd = tempConfigDir.toLowerCase().replace(/\\/g, '/');
            expect(normalizedEntryCwd).toBe(normalizedTempCwd);

            break;
          }

          await new Promise((r) => setTimeout(r, 300));
        }

        expect(historyFound, `No 'on.github.push' event found after ${maxWait}ms`).toBe(true);

        // Step 5: Assert filter deep-equals expected
        expect(subscribeFilter).toEqual({
          source: 'github',
          eventType: ['push'],
          payloadMatch: {},
        });

        // Step 6: Assert relay.log exists and contains expected messages
        const relayLogPath = join(tempConfigDir, 'relay-daemon', 'relay.log');
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

        // Assertion: total test elapsed time should be > 3s (proves negative assertion window ran)
        const elapsedMs = Date.now() - testStartTime;
        expect(elapsedMs).toBeGreaterThan(3000);
      } finally {
        // Step 8: Guaranteed cleanup in finally block (regardless of assertion failures)
        try {
          // Stop relay
          runCli(['relay', 'stop']);

          // Stop queue daemon
          runCli(['stop']);

          // Close WebSocket server
          server.close();

          // Wait for ports to become free (max 5 seconds each)
          const port47910Free = await waitForPortFree(47910, 5000);
          const port47911Free = await waitForPortFree(47911, 5000);

          expect(port47910Free, 'Port 47910 (queue daemon) still in use after stop').toBe(true);
          expect(port47911Free, 'Port 47911 (relay) still in use after stop').toBe(true);

          // Step 9: NEW ASSERTION - Verify relay process actually exited
          // This assertion WILL FAIL until RelayDaemon.ts hooks.onShutdown is wired (expected)
          if (relayDaemonPid !== null) {
            let relayProcessExited = false;
            const relayCheckStart = Date.now();
            while (Date.now() - relayCheckStart < 5000) {
              if (!isProcessRunning(relayDaemonPid)) {
                relayProcessExited = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            // NOTE: This assertion currently FAILS because RelayDaemon.ts doesn't wire hooks.onShutdown
            // The relay process continues running even after `relay stop` returns.
            // TODO: Fix in RelayDaemon.ts
            expect(relayProcessExited, `Relay process ${relayDaemonPid} did not exit after relay stop (RelayDaemon.ts needs hooks.onShutdown)`).toBe(true);
          }

          // Step 10: Verify queue daemon process exited if one was started
          if (queueDaemonPid !== null) {
            let queueProcessExited = false;
            const queueCheckStart = Date.now();
            while (Date.now() - queueCheckStart < 5000) {
              if (!isProcessRunning(queueDaemonPid)) {
                queueProcessExited = true;
                break;
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            expect(queueProcessExited, `Queue daemon process ${queueDaemonPid} did not exit after stop`).toBe(true);
          }
        } finally {
          // Ensure temp dir is removed, with retry for file locks on Windows
          if (tempConfigDir && existsSync(tempConfigDir)) {
            let removed = false;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                rmSync(tempConfigDir, { recursive: true, force: true });
                removed = true;
                break;
              } catch (err) {
                if (attempt < 4) {
                  await new Promise((r) => setTimeout(r, 200));
                }
              }
            }
            if (!removed && existsSync(tempConfigDir)) {
              // If still can't remove, fail the test to expose the lock issue
              expect(true, `Could not remove temp dir ${tempConfigDir} (locked files)`).toBe(false);
            }
          }
        }
      }
    },
    60_000,
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
    let child: ChildProcess | undefined;

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

      let stderr = '';
      let exitCode: number | null | undefined;
      child = spawn(process.execPath, [bundleCopy], {
        cwd: isolatedDir,
        env: { ...process.env, QUEUE_CONFIG_DIR: configDir, NODE_PATH: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('exit', (code) => { exitCode = code; });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && exitCode === undefined && !received.some((m) => m.type === 'subscribe')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(exitCode, `relay daemon exited early with code ${exitCode}; stderr: ${stderr}`).toBeUndefined();
      const subscribe = received.find((m) => m.type === 'subscribe');
      expect(subscribe?.filter, `no subscribe received within 15s; stderr: ${stderr}`).toEqual({
        source: 'github',
        eventType: ['push'],
        payloadMatch: {},
      });
    } finally {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
        child.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
      wss.close();
      rmSync(isolatedDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 30_000);
});
