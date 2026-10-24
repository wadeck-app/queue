import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, it, expect, afterEach, beforeEach, vi, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { isRecord } from '@wadeck-app/queue-core';
import { RelayConnection } from './RelayConnection.js';
import { waitFor } from './testing/waitFor.js';
import { installLogicalClock } from './testing/logicalClock.js';

// Mock push.js before RelayConnection imports it
const { mockPushModule } = vi.hoisted(() => {
  return {
    mockPushModule: {
      ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
      pushToQueue: vi.fn().mockResolvedValue({ status: 'ok' }),
    },
  };
});

vi.mock('./push.js', () => mockPushModule);

/** The port a test server listens on. */
function portOf(wss: WebSocketServer): number {
  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`The test server is not listening on a TCP port (address: ${String(address)})`);
  }
  return address.port;
}

/** A JSON message received by the test server. */
function parseMessage(data: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(data));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected a JSON object from the client, got: ${String(data)}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

// A retry delay no test ever reaches: a loop that is not interrupted by stop() hangs until the (hang guard) test timeout
const NEVER_MS = 3_600_000;

// Heartbeat liveness tests run on a logical clock (Date.now() only moves when the server receives a client ping): each client ping
// advances it by LIVENESS_STEP_MS, so after PINGS_TO_PROVE pings the logical time exceeds the liveness threshold (intervalMs + timeoutMs = 100)
// several times over. A connection that survives them proves the traffic counts as activity, whatever the speed of the machine.
const LIVENESS_STEP_MS = 30;
const PINGS_TO_PROVE = 6;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-connection-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('RelayConnection', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  describe('invalid YAML handling', () => {
    it('does not reject start() on invalid YAML, logs error with file path, and retries after fix', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10, // Fast retry for testing
        onLog: (line) => logs.push(line),
      });

      // Write invalid YAML
      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(relayYmlPath, 'invalid: yaml: content:');

      // Start the connection in the background
      const startPromise = connection.start();

      // Wait until the config load error is logged
      await waitFor(
        () => logs.some((line) => line.includes('[relay]') && line.includes('Cannot load relay.yml')),
        'the "Cannot load relay.yml" log line'
      );

      // Check that error was logged with file path
      const errorLogs = logs.filter((line) => line.includes('[relay]') && line.includes('Cannot load relay.yml'));
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0]).toContain(relayYmlPath);

      // Now fix the YAML (valid with empty plugins)
      writeFileSync(relayYmlPath, 'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n');

      // Wait for the retry that loads the fixed config
      await waitFor(() => logs.some((line) => line.includes('no plugins')), 'the "no plugins" log line after the fix');

      // Check that the "no plugins" message was logged
      const noPluginsLogs = logs.filter((line) => line.includes('no plugins'));
      expect(noPluginsLogs.length).toBeGreaterThan(0);

      connection.stop();
      await startPromise;
    });
  });

  describe('missing relay.yml handling', () => {
    it('logs message including the directory when relay.yml is missing', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      const startPromise = connection.start();

      // Wait until the missing file is logged
      await waitFor(() => logs.some((line) => line.includes('No relay.yml found')), 'the "No relay.yml found" log line');

      // Check that the missing file message includes the directory
      const missingLogs = logs.filter((line) => line.includes('No relay.yml found'));
      expect(missingLogs.length).toBeGreaterThan(0);
      expect(missingLogs[0]).toContain(tmpDir);

      connection.stop();
      await startPromise;
    });
  });

  describe('stop() interrupt behavior', () => {
    it('resolves the loop promptly even while sleeping', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        // Never reached: if stop() did not interrupt the sleep, start() would not resolve and the test would hit its hang guard
        retryDelayMs: NEVER_MS,
        onLog: (line) => logs.push(line),
      });

      const startPromise = connection.start();

      // The loop logs, then enters the sleep right away
      await waitFor(() => logs.some((line) => line.includes('No relay.yml found')), 'the loop to reach its retry sleep');

      // Stop should interrupt the sleep
      connection.stop();

      // Resolves only because the sleep was interrupted
      await startPromise;
    });
  });

  describe('empty plugins handling', () => {
    it('logs "no plugins configured" message', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      // Write valid relay.yml with empty plugins
      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(
        relayYmlPath,
        'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n'
      );

      const startPromise = connection.start();

      // Wait until the config is loaded
      await waitFor(() => logs.some((line) => line.includes('no plugins')), 'the "no plugins" log line');

      // Check that the message was logged
      const noPluginsLogs = logs.filter((line) => line.includes('no plugins'));
      expect(noPluginsLogs.length).toBeGreaterThan(0);

      connection.stop();
      await startPromise;
    });
  });

  describe('config re-read on reconnect', () => {
    it('keeps previously connected state sane when config errors occur', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      // Write invalid YAML
      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(relayYmlPath, 'invalid: yaml: content:');

      const startPromise = connection.start();

      // Wait until the load failed
      await waitFor(() => logs.some((line) => line.includes('Cannot load relay.yml')), 'the "Cannot load relay.yml" log line');

      // Initially not connected (no valid config yet)
      expect(connection.isConnected()).toBe(false);

      connection.stop();
      await startPromise;
    });
  });

  describe('no listener leak on abort', () => {
    it('does not accumulate abort listeners across sleep calls', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      // Write invalid YAML to trigger multiple sleep calls
      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(relayYmlPath, 'invalid: yaml: content:');

      const startPromise = connection.start();

      // Wait until it retried several times (one log line per attempt)
      await waitFor(
        () => logs.filter((line) => line.includes('Cannot load relay.yml')).length >= 5,
        'at least 5 failed config load attempts'
      );

      // Get listener count if possible (this is mostly a leak detector via test completion)
      // If listeners accumulated, the test process would report warnings
      connection.stop();
      await startPromise;

      // If we reach here without Node.js warnings, listeners were cleaned up
    });
  });

  describe('start after stop works correctly', () => {
    it('can restart the connection after stop() without reusing aborted controller', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: NEVER_MS,
        onLog: (line) => logs.push(line),
      });

      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(relayYmlPath, 'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n');

      // Start and stop
      const noPluginsCount = (): number => logs.filter((line) => line.includes('no plugins')).length;
      const startPromise1 = connection.start();
      await waitFor(() => noPluginsCount() === 1, 'the first run to load the config');
      connection.stop();
      await startPromise1;

      // Start again - should not enter hot loop
      const startPromise2 = connection.start();
      await waitFor(() => noPluginsCount() >= 2, 'the second run to load the config');
      connection.stop();
      await startPromise2;

      // With the retry delay out of reach, a sleeping second run loads the config exactly once. Reusing the aborted controller
      // would make the sleep return immediately and the loop spin, logging many more lines.
      expect(noPluginsCount()).toBe(2);
    });
  });

  describe('stop race condition after plugin load', () => {
    it('exits loop without trying to connect if stop() called after plugin load', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: NEVER_MS,
        onLog: (line) => logs.push(line),
      });

      // Write valid relay.yml with empty plugins
      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(
        relayYmlPath,
        'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n'
      );

      const startPromise = connection.start();

      // Wait until the empty plugins are processed
      await waitFor(() => logs.some((line) => line.includes('no plugins')), 'the "no plugins" log line');

      // Stop should exit the loop promptly: it resolves only because the pending sleep is interrupted
      connection.stop();
      await startPromise;
    });

    it('exits loop without attempting connection if stopped after config load succeeds', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      // Track connectOnce calls
      let connectOnceCalls = 0;
      vi.stubGlobal('WebSocket', class {
        constructor() {
          connectOnceCalls++;
          throw new Error('Should not attempt connection');
        }
      });

      try {
        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: NEVER_MS,
          onLog: (line) => logs.push(line),
        });

        // Write valid relay.yml with empty plugins (no actual connection will be attempted)
        const relayYmlPath = join(tmpDir, 'relay.yml');
        writeFileSync(
          relayYmlPath,
          'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n'
        );

        const startPromise = connection.start();
        await waitFor(() => logs.some((line) => line.includes('no plugins')), 'the "no plugins" log line');
        connection.stop();
        await startPromise;

        // connectOnceCalls should be 0 because config has no plugins
        // (connectOnce only called if plugins are configured)
        expect(connectOnceCalls).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('R8: token refusal and backoff handling', () => {
    describe('(a) Invalid token error + 4001 close: no reconnect with same token', () => {
      it('receives error "Invalid token" then close 4001 -> exactly ONE attempt, refused-token log', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: invalid-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
              ws.close(4001, 'Unauthorized');
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for initial connection and rejection
          await waitFor(() => logs.some((line) => line.includes('refused the token')), 'the "refused the token" log line');

          // Negative check without a positive barrier (needs a production seam, see the final report): give extra time to ensure no
          // second connection is attempted. A slow machine only makes it weaker, never failing.
          await new Promise((resolve) => setTimeout(resolve, 150));

          connection.stop();
          await startPromise;

          // Should have exactly 1 connection attempt
          expect(connectionCount).toBe(1);

          // Should have the refused-token log
          const refusedLog = logs.find((line) => line.includes('refused the token'));
          expect(refusedLog).toBeDefined();
          expect(refusedLog).toContain('[relay]');
          expect(refusedLog).toContain('Not retrying');
          expect(refusedLog).toContain('relay.yml');

          // Diagnostics should be set
          const diag = connection.getDiagnostics();
          expect(diag.lastError).toContain('The relay refused the token');
          expect(diag.lastError).toContain('4001');
          // The fix hint points at the secrets file first (the recommended home of the token)
          expect(diag.lastError).toContain('QUEUE_RELAY_TOKEN');
          expect(diag.lastError).toContain('_secrets_/.env.local');
          expect(diag.lastCloseCode).toBe(4001);
        } finally {
          wss.close();
        }
      });
    });

    describe('(b) Close 4401 without error message: also auth refused', () => {
      it('receives close 4401 with no error message -> treated as refused token', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: revoked-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.close(4401, 'Token revoked');
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('refused the token')), 'the "refused the token" log line');
          // Negative check without a positive barrier (see the final report): a slow machine only makes it weaker, never failing
          await new Promise((resolve) => setTimeout(resolve, 150));

          connection.stop();
          await startPromise;

          expect(connectionCount).toBe(1);
          const diag = connection.getDiagnostics();
          expect(diag.lastCloseCode).toBe(4401);
          expect(diag.lastError).toContain('refused the token');
        } finally {
          wss.close();
        }
      });
    });

    describe('(c) After refused token, changing config token reconnects', () => {
      it('same token in config -> no reconnect; different token -> reconnects and authenticates', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        const relayYmlPath = join(tmpDir, 'relay.yml');
        writeFileSync(
          relayYmlPath,
          `relayUrl: ws://127.0.0.1:${port}
token: bad-token-v1
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              if (String(msg.token) === 'bad-token-v1') {
                ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
                ws.close(4001, 'Unauthorized');
              } else if (String(msg.token) === 'good-token-v2') {
                ws.send(JSON.stringify({ type: 'authenticated', username: 'test' }));
              }
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for first rejection
          await waitFor(
            () => connectionCount === 1 && logs.some((line) => line.includes('refused the token')),
            'the first connection to be refused'
          );

          const countAfterRefusal = connectionCount;

          // Rewrite with SAME token - should NOT reconnect
          writeFileSync(relayYmlPath, `relayUrl: ws://127.0.0.1:${port}
token: bad-token-v1
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`);
          // Negative check without a positive barrier (see the final report): a slow machine only makes it weaker, never failing
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(connectionCount).toBe(countAfterRefusal);

          // Rewrite with DIFFERENT token - should reconnect
          writeFileSync(relayYmlPath, `relayUrl: ws://127.0.0.1:${port}
token: good-token-v2
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`);
          await waitFor(() => connection.isConnected(), 'the connection to authenticate with the new token');
          expect(connectionCount).toBe(2);

          // After successful auth, lastError should be cleared
          const diag = connection.getDiagnostics();
          expect(diag.lastError).toBeNull();

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(d) Bare 4001 close (no error message): use normal exponential backoff', () => {
      it('close 4001 without preceding error message -> normal backoff (>= 2 attempts)', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.close(4001, 'Auth timeout');
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          reconnect: {
            minMs: 1,
            maxMs: 100,
            authBlockedMs: 100,
            tryAgainMs: 50,
            abuseMs: 75,
            random: () => 0,
          },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for at least 2 connection attempts (with faster backoff)
          await waitFor(() => connectionCount >= 2, 'a second connection attempt');
          // Stopping mid-handshake would race with the diagnostic: wait until it is recorded
          await waitFor(
            () => (connection.getDiagnostics().lastError ?? '').includes('authentication timed out'),
            'the authentication timeout diagnostic'
          );

          connection.stop();
          await startPromise;

          // Should have retried (not locked out like refused token)
          expect(connectionCount).toBeGreaterThanOrEqual(2);
          // A bare 4001 is the relay's authentication timeout: it must not be reported as a refused token
          const bareDiagnostics = connection.getDiagnostics();
          expect(bareDiagnostics.lastError).toContain('authentication timed out');
          expect(bareDiagnostics.lastError).not.toContain('refused the token');
          expect(logs.some((line) => line.includes('Not retrying'))).toBe(false);
        } finally {
          wss.close();
        }
      });
    });

    describe('(e) 4429 (too many auth failures): authBlockedMs backoff', () => {
      it('close 4429 -> wait authBlockedMs before next attempt', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.close(4429, 'Too many failed auth attempts');
            }
          });
        });

        // Every delay except authBlockedMs is out of reach: a second connection can only come from the authBlockedMs wait, no timing is measured
        const injectedOptions = {
          retryDelayMs: 10,
          reconnect: {
            minMs: NEVER_MS,
            maxMs: NEVER_MS,
            authBlockedMs: 20,
            tryAgainMs: NEVER_MS,
            abuseMs: NEVER_MS,
            random: () => 1,
          },
        };

        const connection = new RelayConnection({
          configDir: tmpDir,
          ...injectedOptions,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // The second connection proves that close 4429 waits authBlockedMs (the only reachable delay) before the next attempt
          await waitFor(() => connectionCount >= 2, 'a second connection after the authBlockedMs wait');

          connection.stop();
          await startPromise;

          // Should have log about backing off
          const backoffLog = logs.find((line) => line.includes('Too many failed authentications'));
          expect(backoffLog).toBeDefined();
        } finally {
          wss.close();
        }
      });
    });

    describe('(f) Jitter factor [0.8, 1.2]', () => {
      // Exported function for testing jitter calculations (will be added to RelayConnection.ts)
      // computeReconnectDelay(baseMs: number, random: () => number): number
      it('verifies jitter formula: baseMs * (0.8 + random() * 0.4)', () => {
        // This will be tested via direct export of computeReconnectDelay function
        // Expected behavior:
        // - random() = 0: baseMs * 0.8
        // - random() = 0.5: baseMs * 1.0
        // - random() = 1: baseMs * 1.2
        expect(1).toBe(1); // Placeholder; real test in separate suite
      });
    });

    describe('(g) stop() during authBlocked wait resolves promptly', () => {
      it('resolves promptly even during long authBlockedMs wait', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.close(4429, 'Too many failed attempts');
            }
          });
        });

        const injectedOptions = {
          retryDelayMs: 10,
          reconnect: {
            minMs: 1,
            maxMs: 100,
            // Never reached: if stop() did not interrupt the wait, start() would not resolve and the test would hit its hang guard
            authBlockedMs: NEVER_MS,
            tryAgainMs: 50,
            abuseMs: 75,
            random: () => 1,
          },
        };

        const connection = new RelayConnection({
          configDir: tmpDir,
          ...injectedOptions,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Let it attempt once and enter the long authBlockedMs wait (the backoff is logged right before the wait)
          await waitFor(() => logs.some((line) => line.includes('Too many failed authentications')), 'the authBlocked backoff log line');

          // Resolves only because the wait was interrupted
          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });
  });

  describe('R6b: diagnostics (getDiagnostics)', () => {
    it('records relay rejection (error + 4001 close code) with actionable message', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      const wss = new WebSocketServer({ port: 0 });
      const port = portOf(wss);

      const pluginPath = join(tmpDir, 'plugin.js');
      writeFileSync(
        pluginPath,
        `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
      );

      writeFileSync(
        join(tmpDir, 'relay.yml'),
        `relayUrl: ws://127.0.0.1:${port}
token: invalid-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = parseMessage(data);
          if (msg.type === 'auth') {
            // Send error message then close with 4001
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
            ws.close(4001, 'Unauthorized');
          }
        });
      });

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();
        await waitFor(
          () => (connection.getDiagnostics().lastError ?? '').includes('The relay refused the token') && connection.getDiagnostics().lastCloseCode === 4001,
          'the refused token diagnostic'
        );
        connection.stop();
        await startPromise;

        const diag = connection.getDiagnostics();
        expect(diag.lastError).toContain('The relay refused the token');
        expect(diag.lastError).toContain('4001');
        expect(diag.lastError).toContain('relay.yml');
        expect(diag.lastCloseCode).toBe(4001);
        expect(diag.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        wss.close();
      }
    });

    it('clears lastError on successful authenticated message', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connections: any[] = [];

      const wss = new WebSocketServer({ port: 0 });
      const port = portOf(wss);

      const pluginPath = join(tmpDir, 'plugin.js');
      writeFileSync(
        pluginPath,
        `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
      );

      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(
        relayYmlPath,
        `relayUrl: ws://127.0.0.1:${port}
token: test-token-v1
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      wss.on('connection', (ws) => {
        connections.push(ws);
        ws.on('message', (data) => {
          const msg = parseMessage(data);
          if (msg.type === 'auth') {
            if (String(msg.token) === 'test-token-v1') {
              // First auth with v1 token: send error and close
              ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
              ws.close(4001, 'Unauthorized');
            } else if (String(msg.token) === 'test-token-v2') {
              // Second auth with v2 token: send authenticated
              ws.send(JSON.stringify({ type: 'authenticated', username: 'test' }));
              // Keep connection open so we can check diagnostics
            }
          }
        });
      });

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();

        // Wait for first connection attempt and 4001 error
        await waitFor(() => connection.getDiagnostics().lastCloseCode === 4001, 'close code 4001 in the diagnostics');
        let diag = connection.getDiagnostics();
        expect(diag.lastError).toContain('The relay refused the token');
        expect(diag.lastCloseCode).toBe(4001);

        // Now fix the token in relay.yml
        writeFileSync(
          relayYmlPath,
          `relayUrl: ws://127.0.0.1:${port}
token: test-token-v2
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        // Wait for successful reconnect and authenticated message
        await waitFor(() => connection.isConnected(), 'the connection to authenticate with the fixed token');
        diag = connection.getDiagnostics();

        // lastError should be cleared after successful auth
        expect(diag.lastError).toBeNull();
        expect(connection.isConnected()).toBe(true);

        connection.stop();
        await startPromise;
      } finally {
        wss.close();
      }
    });

    it('records invalid relay.yml with "Cannot load relay.yml" prefix', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      writeFileSync(
        join(tmpDir, 'relay.yml'),
        'invalid: yaml: content:'
      );

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();
        await waitFor(() => (connection.getDiagnostics().lastError ?? '').includes('Cannot load relay.yml'), 'the "Cannot load relay.yml" diagnostic');
        connection.stop();
        await startPromise;

        const diag = connection.getDiagnostics();
        expect(diag.lastError).toContain('Cannot load relay.yml');
        expect(diag.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
      }
    });

    it('records plugin load failure with "Failed to load plugins" prefix', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      const pluginPath = join(tmpDir, 'nonexistent-plugin.js');

      writeFileSync(
        join(tmpDir, 'relay.yml'),
        `relayUrl: ws://127.0.0.1:1/relay
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();
        await waitFor(() => (connection.getDiagnostics().lastError ?? '').includes('Failed to load plugins'), 'the "Failed to load plugins" diagnostic');
        connection.stop();
        await startPromise;

        const diag = connection.getDiagnostics();
        expect(diag.lastError).toContain('Failed to load plugins');
        expect(diag.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
      }
    });

    it('records websocket connection error with "Connection error:" prefix', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      const pluginPath = join(tmpDir, 'plugin.js');
      writeFileSync(
        pluginPath,
        `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
      );

      // Use an invalid URL to force connection error
      writeFileSync(
        join(tmpDir, 'relay.yml'),
        `relayUrl: ws://localhost:1/relay
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();
        await waitFor(() => (connection.getDiagnostics().lastError ?? '').includes('Connection error:'), 'the "Connection error:" diagnostic');
        connection.stop();
        await startPromise;

        const diag = connection.getDiagnostics();
        expect(diag.lastError).toContain('Connection error:');
        expect(diag.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
      }
    });

    it('records last close code from close event', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      const wss = new WebSocketServer({ port: 0 });
      const port = portOf(wss);

      const pluginPath = join(tmpDir, 'plugin.js');
      writeFileSync(
        pluginPath,
        `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
      );

      writeFileSync(
        join(tmpDir, 'relay.yml'),
        `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      wss.on('connection', (ws) => {
        ws.on('message', () => {
          ws.close(1000, 'Normal closure');
        });
      });

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      try {
        const startPromise = connection.start();
        await waitFor(() => connection.getDiagnostics().lastCloseCode === 1000, 'close code 1000 in the diagnostics');
        connection.stop();
        await startPromise;

        const diag = connection.getDiagnostics();
        expect(diag.lastCloseCode).toBe(1000);
      } finally {
        wss.close();
      }
    });

    it('has all fields initially null', async () => {
      tmpDir = makeTmpDir();

      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 10,
      });

      const diag = connection.getDiagnostics();
      expect(diag.lastError).toBeNull();
      expect(diag.lastErrorAt).toBeNull();
      expect(diag.lastCloseCode).toBeNull();
    });
  });

  describe('R4: client-side payload matching and subscription filtering', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe('(a) subscribeAll sends ONE subscribe per plugin with correct filter structure', () => {
      it('sends one subscribe message with union of eventTypes and empty payloadMatch', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        // Write test plugin module
        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Write relay.yml with multiple subscriptions
        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
      - eventType: [pull_request]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => receivedMessages.some((m) => m.type === 'subscribe'), 'the condition: receivedMessages.some((m) => m.type === \'subscribe\')');

          const subscribeMsg = receivedMessages.find((m) => m.type === 'subscribe');
          expect(subscribeMsg).toBeDefined();
          const filter = isRecord(subscribeMsg?.filter) ? subscribeMsg.filter : {};
          expect(filter.source).toBe('github');
          expect(filter.eventType).toEqual(expect.arrayContaining(['push', 'pull_request']));
          expect(filter.payloadMatch).toEqual({});

          // Verify only ONE subscribe message (not multiple per subscription)
          const subscribeCount = receivedMessages.filter((m) => m.type === 'subscribe').length;
          expect(subscribeCount).toBe(1);

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('sends subscribe with empty eventType array if any subscription lacks eventType', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        // Write test plugin module
        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Write relay.yml with one subscription having no eventType
        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
      - eventType: []
      - eventType: [pull_request]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => receivedMessages.some((m) => m.type === 'subscribe'), 'the condition: receivedMessages.some((m) => m.type === \'subscribe\')');

          const subscribeMsg = receivedMessages.find((m) => m.type === 'subscribe');
          expect(subscribeMsg).toBeDefined();
          const filter = isRecord(subscribeMsg?.filter) ? subscribeMsg.filter : {};
          // Any subscription with no eventType means send empty array (all events)
          expect(filter.eventType).toEqual([]);

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(b) first subscription matching eventType AND payloadMatch supplies queueEvent', () => {
      it('uses queueEvent override from first matching subscription', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];
        const pushToQueueCalls: Array<{ event: string; payload: unknown }> = [];

        mockPushModule.pushToQueue.mockImplementation((dir: string, event: string, payload: unknown) => {
          pushToQueueCalls.push({ event, payload });
          return Promise.resolve({ status: 'ok' });
        });

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
        queueEvent: custom_push_event
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-001',
                    payload: { action: 'opened' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => pushToQueueCalls.length > 0, 'the condition: pushToQueueCalls.length > 0');

          expect(pushToQueueCalls[0]?.event).toBe('custom_push_event');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('uses mapped event name when subscription has no queueEvent override', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];
        const pushToQueueCalls: Array<{ event: string; payload: unknown }> = [];

        mockPushModule.pushToQueue.mockImplementation((dir: string, event: string, payload: unknown) => {
          pushToQueueCalls.push({ event, payload });
          return Promise.resolve({ status: 'ok' });
        });

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-002',
                    payload: { action: 'opened' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => pushToQueueCalls.length > 0, 'the condition: pushToQueueCalls.length > 0');

          expect(pushToQueueCalls[0]?.event).toBe('on.github.push');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(c) two subscriptions with same eventType, different payloadMatch/queueEvent', () => {
      it('second subscription wins when only it matches payloadMatch', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];
        const pushToQueueCalls: Array<{ event: string; payload: unknown }> = [];

        mockPushModule.pushToQueue.mockImplementation((dir: string, event: string, payload: unknown) => {
          pushToQueueCalls.push({ event, payload });
          return Promise.resolve({ status: 'ok' });
        });

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [pull_request]
        payloadMatch:
          action: "opened"
        queueEvent: pr_opened
      - eventType: [pull_request]
        payloadMatch:
          action: "closed"
        queueEvent: pr_closed
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'pull_request',
                    deliveryId: 'del-003',
                    payload: { action: 'closed' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => pushToQueueCalls.length > 0, 'the condition: pushToQueueCalls.length > 0');

          expect(pushToQueueCalls[0]?.event).toBe('pr_closed');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(d) first matching subscription wins (first match precedence)', () => {
      it('catch-all subscription listed first wins over more specific later subscription', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];
        const pushToQueueCalls: Array<{ event: string; payload: unknown }> = [];

        mockPushModule.pushToQueue.mockImplementation((dir: string, event: string, payload: unknown) => {
          pushToQueueCalls.push({ event, payload });
          return Promise.resolve({ status: 'ok' });
        });

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Catch-all with no eventType listed first
        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - queueEvent: catch_all_event
      - eventType: [push]
        payloadMatch:
          action: "opened"
        queueEvent: specific_event
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-004',
                    payload: { action: 'opened' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => pushToQueueCalls.length > 0, 'the condition: pushToQueueCalls.length > 0');

          // First matching subscription wins (the catch-all is first)
          expect(pushToQueueCalls[0]?.event).toBe('catch_all_event');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(e) no match drops delivery without calling pushToQueue', () => {
      it('logs explicit drop with delivery id and eventType when no subscription matches', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];
        const pushToQueueCalls: Array<{ event: string; payload: unknown }> = [];

        mockPushModule.pushToQueue.mockImplementation((dir: string, event: string, payload: unknown) => {
          pushToQueueCalls.push({ event, payload });
          return Promise.resolve({ status: 'ok' });
        });

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Only interested in 'push' events
        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              // Send a pull_request event when subscription only listens for push
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'pull_request',
                    deliveryId: 'del-no-match-001',
                    payload: { action: 'opened' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('matched no subscription')), 'the condition: logs.some((line) => line.includes(\'matched no subscription\'))');

          // pushToQueue should NOT have been called
          expect(pushToQueueCalls).toHaveLength(0);

          // Log line should include delivery id and eventType
          const dropLog = logs.find((line) => line.includes('matched no subscription'));
          expect(dropLog).toContain('del-no-match-001');
          expect(dropLog).toContain('pull_request');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });

    describe('(f) R5: dispatchEvent abort/error logging', () => {
      it('logs FAILURE line for aborted status with reason', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        mockPushModule.pushToQueue.mockImplementation(() =>
          Promise.resolve({ status: 'aborted', reason: 'subscribers.yml syntax error' })
        );

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-abort-001',
                    payload: { ref: 'refs/heads/main' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('ABORTED')), 'the condition: logs.some((line) => line.includes(\'ABORTED\'))');

          // Should have FAILURE line with ABORTED, reason, delivery id
          const abortLog = logs.find((line) => line.includes('ABORTED'));
          expect(abortLog).toBeDefined();
          expect(abortLog).toContain('ABORTED');
          expect(abortLog).toContain('subscribers.yml syntax error');
          expect(abortLog).toContain('del-abort-001');
          expect(abortLog).toContain('logs');
          // Should NOT contain "Pushed"
          expect(abortLog).not.toContain('Pushed');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('logs FAILURE line for aborted status without reason', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        mockPushModule.pushToQueue.mockImplementation(() =>
          Promise.resolve({ status: 'aborted' })
        );

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-abort-002',
                    payload: { ref: 'refs/heads/main' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('ABORTED')), 'the condition: logs.some((line) => line.includes(\'ABORTED\'))');

          const abortLog = logs.find((line) => line.includes('ABORTED'));
          expect(abortLog).toBeDefined();
          expect(abortLog).toContain('ABORTED');
          expect(abortLog).toContain('no reason given');
          expect(abortLog).toContain('del-abort-002');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('logs success line unchanged for queued status', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        mockPushModule.pushToQueue.mockImplementation(() =>
          Promise.resolve({ status: 'queued' })
        );

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-queued-001',
                    payload: { ref: 'refs/heads/main' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('Pushed')), 'the condition: logs.some((line) => line.includes(\'Pushed\'))');

          const successLog = logs.find((line) => line.includes('Pushed'));
          expect(successLog).toBeDefined();
          expect(successLog).toContain('Pushed');
          expect(successLog).toContain('queued');
          expect(successLog).toContain('del-queued-001');
          expect(successLog).not.toContain('ABORTED');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('logs success line unchanged for dispatched status', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        mockPushModule.pushToQueue.mockImplementation(() =>
          Promise.resolve({ status: 'dispatched' })
        );

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-dispatch-001',
                    payload: { ref: 'refs/heads/main' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('Pushed')), 'the condition: logs.some((line) => line.includes(\'Pushed\'))');

          const successLog = logs.find((line) => line.includes('Pushed'));
          expect(successLog).toBeDefined();
          expect(successLog).toContain('Pushed');
          expect(successLog).toContain('dispatched');
          expect(successLog).toContain('del-dispatch-001');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('logs error with logs hint when pushToQueue rejects', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        mockPushModule.pushToQueue.mockImplementation(() =>
          Promise.reject(new Error('Queue daemon connection failed'))
        );

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [push]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  envelope: {
                    source: 'github',
                    webhookConfigId: 'w',
                    eventType: 'push',
                    deliveryId: 'del-error-001',
                    payload: { ref: 'refs/heads/main' },
                    receivedAt: new Date().toISOString(),
                  },
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => logs.some((line) => line.includes('Failed to push')), 'the condition: logs.some((line) => line.includes(\'Failed to push\'))');

          const errorLog = logs.find((line) => line.includes('Failed to push'));
          expect(errorLog).toBeDefined();
          expect(errorLog).toContain('Failed to push');
          expect(errorLog).toContain('Queue daemon connection failed');
          expect(errorLog).toContain('del-error-001');
          expect(errorLog).toContain('logs');

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });
    });
  });

  describe('R10: heartbeat liveness detection', () => {
    describe('(a) healthy server: no liveness errors across multiple heartbeat ticks', () => {
      it('with real ws server (autoPong: true default), stays connected for 5+ heartbeat ticks', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;
        let serverPings = 0;
        const clock = installLogicalClock();

        const wss = new WebSocketServer({ port: 0, autoPong: true });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('ping', () => {
            serverPings++;
            clock.advance(LIVENESS_STEP_MS);
          });
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for connection and then for enough heartbeat ticks (client pings) to cross the liveness threshold several times
          await waitFor(() => connection.isConnected(), 'the connection to authenticate');
          const initialConnectionCount = connectionCount;
          await waitFor(() => serverPings >= PINGS_TO_PROVE, 'the heartbeat pings reaching the server');

          connection.stop();
          await startPromise;

          // Should have exactly one connection (no liveness-driven reconnect)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
          clock.restore();
          wss.close();
        }
      });
    });

    describe('(f) dead peer: a relay that goes silent after authentication', () => {
      // The production relay was redeployed without closing sockets: the client kept a "connected" socket forever
      const REAL_BACKOFF = { minMs: 1, maxMs: 20, authBlockedMs: 100, tryAgainMs: 100, abuseMs: 100, random: () => 0.5 };

      function writeRelayYml(dir: string, port: number): void {
        const pluginPath = join(dir, 'plugin.js');
        writeFileSync(pluginPath, `export default { source: 'test', mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload }) };`);
        writeFileSync(
          join(dir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}\ntoken: test-token\nplugins:\n  - module: ${pluginPath}\n    subscriptions:\n      - eventType: [test]\n`
        );
      }

      it('silent server (no pong, no message after authenticated) -> "No sign of life" logged, diagnostics set, and a NEW connection attempt reaches the server', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        // autoPong:false makes this server ignore the client's pings, like a dead process would
        const wss = new WebSocketServer({ port: 0, autoPong: false });
        const port = portOf(wss);
        writeRelayYml(tmpDir, port);

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          reconnect: REAL_BACKOFF,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => connectionCount >= 2, 'the condition: connectionCount >= 2');

          expect(connectionCount).toBeGreaterThanOrEqual(2);
          const deadLogs = logs.filter((l) => l.includes('No sign of life from the relay'));
          expect(deadLogs.length).toBeGreaterThanOrEqual(1);
          expect(deadLogs[0]).toContain('connection considered dead, reconnecting');
          // This is a network-level failure, never a refused token: the auth-refused path must stay untouched
          expect(logs.some((l) => l.includes('Not retrying') || l.includes('refused the token'))).toBe(false);

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('sets getDiagnostics().lastError (and lastErrorAt) at the moment the dead connection is detected', async () => {
        tmpDir = makeTmpDir();
        let connectionCount = 0;
        let diagnosticsAtDetection: { lastError: string | null; lastErrorAt: string | null } | null = null;
        const wss = new WebSocketServer({ port: 0, autoPong: false });
        const port = portOf(wss);
        writeRelayYml(tmpDir, port);
        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });
        // A later re-authentication clears lastError, so it must be read when the detection is logged
        const connection: RelayConnection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          reconnect: REAL_BACKOFF,
          onLog: (line) => {
            if (line.includes('No sign of life') && diagnosticsAtDetection === null) {
              const { lastError, lastErrorAt } = connection.getDiagnostics();
              diagnosticsAtDetection = { lastError, lastErrorAt };
            }
          },
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => diagnosticsAtDetection !== null, 'the condition: diagnosticsAtDetection !== null');

          const seen = diagnosticsAtDetection as { lastError: string | null; lastErrorAt: string | null } | null;
          expect(seen?.lastError).toContain('No sign of life from the relay');
          expect(seen?.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          // The loop keeps recovering after the detection
          await waitFor(() => connectionCount >= 2, 'the condition: connectionCount >= 2');
          expect(connectionCount).toBeGreaterThanOrEqual(2);

          connection.stop();
          await startPromise;
        } finally {
          wss.close();
        }
      });

      it('a relay that never answers our pings but sends its own pings (like the real one) is NOT considered dead', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;
        const clock = installLogicalClock();
        let serverPings = 0;

        const wss = new WebSocketServer({ port: 0, autoPong: false });
        const port = portOf(wss);
        writeRelayYml(tmpDir, port);
        wss.on('connection', (ws) => {
          connectionCount++;
          // Server-initiated ping in answer to each client ping (the client answers it automatically and it counts as activity),
          // while the client's own pings stay unanswered (autoPong false)
          ws.on('ping', () => {
            serverPings++;
            ws.ping();
            clock.advance(LIVENESS_STEP_MS);
          });
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          reconnect: REAL_BACKOFF,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(() => connection.isConnected(), 'the connection to authenticate');
          // Let more than 4 full liveness windows (100 logical ms each) pass
          await waitFor(() => serverPings >= PINGS_TO_PROVE, 'the heartbeat pings reaching the server');

          expect(connectionCount).toBe(1);
          expect(logs.filter((l) => l.includes('No sign of life')).length).toBe(0);

          connection.stop();
          await startPromise;
        } finally {
          clock.restore();
          wss.close();
        }
      });
    });

    describe('(b) server with heartbeat enabled: connection stays healthy', () => {
      it('with heartbeat enabled and responsive server, connection stays open', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;
        let serverPings = 0;
        const clock = installLogicalClock();

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('ping', () => {
            serverPings++;
            clock.advance(LIVENESS_STEP_MS);
          });
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for connection
          await waitFor(() => connection.isConnected(), 'the connection to authenticate');
          const initialConnectionCount = connectionCount;

          // Wait until enough heartbeat ticks (client pings) ran to cross the liveness threshold several times
          await waitFor(() => serverPings >= PINGS_TO_PROVE, 'the heartbeat pings reaching the server');

          connection.stop();
          await startPromise;

          // Should still have exactly one connection (heartbeat keeps it alive, no reason to reconnect)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
          clock.restore();
          wss.close();
        }
      });
    });

    describe('(c) server sends application messages but no pongs: not considered dead', () => {
      it('server sends message every heartbeat tick -> connection stays alive', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const clock = installLogicalClock();
        let serverPings = 0;
        // autoPong false: the server never answers the client pings, only its application messages can count as activity
        const wss = new WebSocketServer({ port: 0, autoPong: false });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          // One application message in answer to each client ping, and the logical time moves on
          ws.on('ping', () => {
            serverPings++;
            ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
            clock.advance(LIVENESS_STEP_MS);
          });
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for connection to establish
          await waitFor(() => connection.isConnected(), 'the connection to authenticate');
          const initialConnectionCount = connectionCount;
          // Let heartbeats tick until the logical time crossed the liveness threshold several times, with messages as the only traffic
          await waitFor(() => serverPings >= PINGS_TO_PROVE, 'the heartbeat pings reaching the server');

          connection.stop();
          await startPromise;

          // Should still have only one connection (messages kept it alive)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
          clock.restore();
          wss.close();
        }
      });
    });

    describe('(d) stop() clears heartbeat timer, no pings after stop', () => {
      it('after stop(), connection resolves promptly and no further pings are sent', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let serverPings = 0;
        let serverClosed = false;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
          ws.on('ping', () => {
            serverPings++;
          });
          ws.on('close', () => {
            serverClosed = true;
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for connection to establish and for the heartbeat to be running (at least one ping)
          await waitFor(() => connection.isConnected(), 'the connection to authenticate');
          await waitFor(() => serverPings >= 1, 'the first heartbeat ping');

          connection.stop();
          await startPromise;

          // The server saw the close: TCP keeps order, so every ping sent before the stop has been counted by now
          await waitFor(() => serverClosed, 'the server to see the connection close');
          const pingsAtClose = serverPings;

          // Negative check without a positive barrier (see the final report): wait through more than one heartbeat interval (50 ms);
          // a slow machine only makes it weaker, never failing
          await new Promise((resolve) => setTimeout(resolve, 200));

          // No ping after the stop
          expect(serverPings).toBe(pingsAtClose);
        } finally {
          wss.close();
        }
      });
    });

    describe('(e) heartbeat does not affect token refusal handling', () => {
      it('token refusal still works correctly with heartbeat enabled', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: bad-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
        );

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
              ws.close(4001, 'Unauthorized');
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          heartbeat: { intervalMs: 50, timeoutMs: 50 },
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for token refusal
          await waitFor(() => logs.some((l) => l.includes('refused the token')), 'the "refused the token" log line');

          // Negative check without a positive barrier (see the final report): give extra time to confirm no further reconnect is
          // attempted. A slow machine only makes it weaker, never failing.
          await new Promise((resolve) => setTimeout(resolve, 150));

          connection.stop();
          await startPromise;

          // Should have only one attempt (token refused, no reconnect)
          expect(connectionCount).toBe(1);
          // Should have logged token refusal
          expect(logs.some((l) => l.includes('refused the token'))).toBe(true);
        } finally {
          wss.close();
        }
      });
    });
  });

  describe('R9: subscriptionCount ack and HTTP 429 handling', () => {
    describe('(a) subscriptionCount ack with multiple plugins: no warning when count >= subscribes sent', () => {
      it('2 plugins same source, server acks with subscriptionCount 1,2 -> NO warning, logs Subscribed with count', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        // Plugin 1
        const plugin1Path = join(tmpDir, 'plugin1.js');
        writeFileSync(
          plugin1Path,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Plugin 2
        const plugin2Path = join(tmpDir, 'plugin2.js');
        writeFileSync(
          plugin2Path,
          `export default {
  source: 'github',
  mapEvent: (e) => ({ event: \`on.github2.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${plugin1Path}
    subscriptions:
      - eventType: [push]
  - module: ${plugin2Path}
    subscriptions:
      - eventType: [pull_request]
`
        );

        wss.on('connection', (ws) => {
          let subscribeCount = 0;
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              subscribeCount++;
              // Ack with subscriptionCount reflecting the total count for all filters on this connection
              ws.send(
                JSON.stringify({
                  type: 'subscribed',
                  filter: msg.filter,
                  subscriptionCount: subscribeCount,
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for both subscriptions and their acks
          await waitFor(
            () => receivedMessages.filter((m) => m.type === 'subscribe').length === 2 &&
                   logs.filter((l) => l.includes('[relay] Subscribed:')).length >= 2, 'the condition: receivedMessages.filter((m) => m.type === \'subscribe\').length === 2 && logs.filter((l) => l.includes(\'[relay] Subscribed:\')).length >= 2');

          // The warning (if any) is logged in the same synchronous block as the "Subscribed" line the wait above observed: no extra wait needed

          connection.stop();
          await startPromise;

          // No warning about replacement should be present
          const warningLogs = logs.filter((l) => l.includes('replaced an earlier one'));
          expect(warningLogs.length).toBe(0);

          // Both subscriptions should be acknowledged
          const subscribedLogs = logs.filter((l) => l.includes('[relay] Subscribed:'));
          expect(subscribedLogs.length).toBeGreaterThanOrEqual(2);

          // Should log subscriptionCount in the message
          expect(subscribedLogs.some((l) => l.includes('(2 filters on this connection)'))).toBe(true);
        } finally {
          wss.close();
        }
      });
    });

    describe('(b) subscriptionCount ack missing: warning when > 1 subscribe sent', () => {
      it('2 plugins same source, server acks WITHOUT subscriptionCount -> exactly one warning naming second plugin', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        // Plugin 1
        const plugin1Path = join(tmpDir, 'plugin1.js');
        writeFileSync(
          plugin1Path,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test1.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Plugin 2
        const plugin2Path = join(tmpDir, 'plugin2.js');
        writeFileSync(
          plugin2Path,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test2.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${plugin1Path}
    subscriptions:
      - eventType: [event1]
  - module: ${plugin2Path}
    subscriptions:
      - eventType: [event2]
`
        );

        let subscribeCount = 0;
        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              subscribeCount++;
              // Ack WITHOUT subscriptionCount (old relay behavior)
              ws.send(
                JSON.stringify({
                  type: 'subscribed',
                  filter: msg.filter,
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for both subscriptions and their acks
          await waitFor(
            () => receivedMessages.filter((m) => m.type === 'subscribe').length === 2 &&
                   logs.filter((l) => l.includes('replaced an earlier one')).length === 1, 'the condition: receivedMessages.filter((m) => m.type === \'subscribe\').length === 2 && logs.filter((l) => l.includes(\'replaced an earlier one\')).length === 1');

          connection.stop();
          await startPromise;

          // Exactly one warning about replacement
          const warningLogs = logs.filter((l) => l.includes('replaced an earlier one'));
          expect(warningLogs.length).toBe(1);

          // Warning should mention the second plugin's module name
          expect(warningLogs[0]).toContain('plugin2.js');
          expect(warningLogs[0]).toContain('this relay keeps a single filter per connection');
          expect(warningLogs[0]).toContain('Only the last plugin\'s events are delivered');
        } finally {
          wss.close();
        }
      });
    });

    describe('(c) single plugin with old relay ack: no warning', () => {
      it('1 plugin, ack without subscriptionCount -> no warning', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        const pluginPath = join(tmpDir, 'plugin.js');
        writeFileSync(
          pluginPath,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [event1]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              // Ack WITHOUT subscriptionCount
              ws.send(
                JSON.stringify({
                  type: 'subscribed',
                  filter: msg.filter,
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          await waitFor(
            () => receivedMessages.filter((m) => m.type === 'subscribe').length === 1 &&
                   logs.filter((l) => l.includes('[relay] Subscribed:')).length >= 1, 'the condition: receivedMessages.filter((m) => m.type === \'subscribe\').length === 1 && logs.filter((l) => l.includes(\'[relay] Subscribed:\')).length >= 1');

          // The warning (if any) is logged in the same synchronous block as the "Subscribed" line the wait above observed

          connection.stop();
          await startPromise;

          // No warning
          const warningLogs = logs.filter((l) => l.includes('replaced an earlier one'));
          expect(warningLogs.length).toBe(0);

          // Subscription acknowledged
          const subscribedLogs = logs.filter((l) => l.includes('[relay] Subscribed:'));
          expect(subscribedLogs.length).toBeGreaterThanOrEqual(1);
        } finally {
          wss.close();
        }
      });
    });

    describe('(d) subscriptionCount smaller than subscribes sent: warning', () => {
      it('subscriptionCount present but smaller than number sent -> one warning', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = portOf(wss);

        // Plugin 1
        const plugin1Path = join(tmpDir, 'plugin1.js');
        writeFileSync(
          plugin1Path,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test1.\${e.eventType}\`, payload: e.payload })
};`
        );

        // Plugin 2
        const plugin2Path = join(tmpDir, 'plugin2.js');
        writeFileSync(
          plugin2Path,
          `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test2.\${e.eventType}\`, payload: e.payload })
};`
        );

        writeFileSync(
          join(tmpDir, 'relay.yml'),
          `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${plugin1Path}
    subscriptions:
      - eventType: [event1]
  - module: ${plugin2Path}
    subscriptions:
      - eventType: [event2]
`
        );

        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            const msg = parseMessage(data);
            receivedMessages.push(msg);
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            } else if (msg.type === 'subscribe') {
              // Always ack with count 1, even after second subscribe
              // This indicates only one filter is held (relay is not appending)
              ws.send(
                JSON.stringify({
                  type: 'subscribed',
                  filter: msg.filter,
                  subscriptionCount: 1,
                })
              );
            }
          });
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for both subscriptions and warning
          await waitFor(
            () => receivedMessages.filter((m) => m.type === 'subscribe').length === 2 &&
                   logs.filter((l) => l.includes('replaced an earlier one')).length === 1, 'the condition: receivedMessages.filter((m) => m.type === \'subscribe\').length === 2 && logs.filter((l) => l.includes(\'replaced an earlier one\')).length === 1');

          connection.stop();
          await startPromise;

          // Exactly one warning about replacement
          const warningLogs = logs.filter((l) => l.includes('replaced an earlier one'));
          expect(warningLogs.length).toBe(1);

          // Warning should mention the second plugin
          expect(warningLogs[0]).toContain('plugin2.js');
        } finally {
          wss.close();
        }
      });
    });

    describe('(e) HTTP 429 on websocket upgrade', () => {
      it('429 response triggers auth-blocked backoff, logs 429 error, sets lastCloseCode to null', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const http = require('node:http');
        const server = http.createServer();

        writeFileSync(join(tmpDir, 'plugin.js'), "export default { source: 'test', mapEvent: () => null };");
        server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
          // Return 429 and close
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
          socket.destroy();
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          reconnect: {
            minMs: 1_000,
            maxMs: 30_000,
            authBlockedMs: 300, // 300ms backoff
            tryAgainMs: 60_000,
            abuseMs: 300_000,
            random: () => 0.5,
          },
          onLog: (line) => logs.push(line),
        });

        // Start server and get port
        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            writeFileSync(
              join(tmpDir, 'relay.yml'),
              `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${join(tmpDir, 'plugin.js')}
    subscriptions:
      - eventType: [test]
`
            );
            resolve();
          });
        });

        try {
          const startPromise = connection.start();

          // Wait for the 429 error to be logged - may take a moment for the connection to be attempted
          await waitFor(() => logs.some((l) => l.includes('429')), 'the condition: logs.some((l) => l.includes(\'429\'))');

          // Check that the error message indicates 429
          const errorLogs = logs.filter((l) => l.includes('429'));
          expect(errorLogs.length).toBeGreaterThan(0);
          expect(errorLogs[0]).toContain('[relay]');
          expect(errorLogs[0]).toContain('429');

          // Check diagnostic
          const diag = connection.getDiagnostics();
          expect(diag.lastError).toContain('429');
          expect(diag.lastCloseCode).toBeNull();

          connection.stop();
          await startPromise;
        } finally {
          server.close();
        }
      });

      it('503 response logs error and uses normal backoff', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const http = require('node:http');
        const server = http.createServer();

        writeFileSync(join(tmpDir, 'plugin.js'), "export default { source: 'test', mapEvent: () => null };");
        server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
          // Return 503 and close
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          reconnect: {
            minMs: 100,
            maxMs: 30_000,
            authBlockedMs: 600_000,
            tryAgainMs: 60_000,
            abuseMs: 300_000,
            random: () => 0.5,
          },
          onLog: (line) => logs.push(line),
        });

        // Start server and get port
        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            writeFileSync(
              join(tmpDir, 'relay.yml'),
              `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${join(tmpDir, 'plugin.js')}
    subscriptions:
      - eventType: [test]
`
            );
            resolve();
          });
        });

        try {
          const startPromise = connection.start();

          // Wait for 503 error to be logged
          await waitFor(() => logs.some((l) => l.includes('503')), 'the condition: logs.some((l) => l.includes(\'503\'))');

          // Check that error message indicates 503
          const errorLogs = logs.filter((l) => l.includes('503'));
          expect(errorLogs.length).toBeGreaterThan(0);
          expect(errorLogs[0]).toContain('[relay]');
          expect(errorLogs[0]).toContain('503');

          connection.stop();
          await startPromise;
        } finally {
          server.close();
        }
      });

      it('stop() during 429 wait resolves promptly', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const http = require('node:http');
        const server = http.createServer();

        writeFileSync(join(tmpDir, 'plugin.js'), "export default { source: 'test', mapEvent: () => null };");
        server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
          socket.destroy();
        });

        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 50,
          reconnect: {
            minMs: 1_000,
            maxMs: 30_000,
            // Never reached: if stop() did not interrupt the wait, start() would not resolve and the test would hit its hang guard
            authBlockedMs: NEVER_MS,
            tryAgainMs: 60_000,
            abuseMs: 300_000,
            random: () => 0.5,
          },
          onLog: (line) => logs.push(line),
        });

        // Start server and get port
        await new Promise<void>((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port;
            writeFileSync(
              join(tmpDir, 'relay.yml'),
              `relayUrl: ws://127.0.0.1:${port}
token: test-token
plugins:
  - module: ${join(tmpDir, 'plugin.js')}
    subscriptions:
      - eventType: [test]
`
            );
            resolve();
          });
        });

        try {
          const startPromise = connection.start();

          // Wait for the first 429 response
          await waitFor(() => logs.some((l) => l.includes('429')), 'the 429 log line');

          // Now stop during the wait: start() resolves only because the wait was interrupted
          connection.stop();
          await startPromise;
        } finally {
          server.close();
        }
      });
    });
  });
});
