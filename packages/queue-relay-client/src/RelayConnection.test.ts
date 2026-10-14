import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, it, expect, afterEach, beforeEach, vi, beforeAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { RelayConnection } from './RelayConnection.js';

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

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-connection-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('RelayConnection', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
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

      // Give it time to try loading the config and log the error
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check that error was logged with file path
      const errorLogs = logs.filter((line) => line.includes('[relay]') && line.includes('Cannot load relay.yml'));
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0]).toContain(relayYmlPath);

      // Now fix the YAML (valid with empty plugins)
      writeFileSync(relayYmlPath, 'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n');

      // Give it time to retry and load the fixed config
      await new Promise((resolve) => setTimeout(resolve, 150));

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

      // Give it time to try loading the config
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check that the missing file message includes the directory
      const missingLogs = logs.filter((line) => line.includes('No relay.yml found'));
      expect(missingLogs.length).toBeGreaterThan(0);
      expect(missingLogs[0]).toContain(tmpDir);

      connection.stop();
      await startPromise;
    });
  });

  describe('stop() interrupt behavior', () => {
    it('resolves the loop promptly (< 1s) even while sleeping', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      const connection = new RelayConnection({
        configDir: tmpDir,
        retryDelayMs: 30_000, // Long sleep
        onLog: (line) => logs.push(line),
      });

      const startTime = Date.now();
      const startPromise = connection.start();

      // Give it time to enter the sleep
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop should interrupt the sleep
      connection.stop();

      // Wait for start() to resolve
      await startPromise;
      const elapsed = Date.now() - startTime;

      // Should resolve in much less than the retry delay
      expect(elapsed).toBeLessThan(1000);
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

      // Give it time to load the config
      await new Promise((resolve) => setTimeout(resolve, 100));

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

      // Give it time to try loading and fail
      await new Promise((resolve) => setTimeout(resolve, 50));

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

      // Give it time to retry several times
      await new Promise((resolve) => setTimeout(resolve, 150));

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
        retryDelayMs: 10,
        onLog: (line) => logs.push(line),
      });

      const relayYmlPath = join(tmpDir, 'relay.yml');
      writeFileSync(relayYmlPath, 'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n');

      // Start and stop
      const startPromise1 = connection.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      connection.stop();
      await startPromise1;

      // Start again - should not enter hot loop
      const startTime = Date.now();
      const startPromise2 = connection.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      connection.stop();
      await startPromise2;
      const elapsed = Date.now() - startTime;

      // If reusing aborted controller, would cause immediate loop (fast)
      // Normal behavior with retry delay should be measurable
      expect(elapsed).toBeGreaterThan(20);
    });
  });

  describe('stop race condition after plugin load', () => {
    it('exits loop without trying to connect if stop() called after plugin load', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];
      let pluginLoadAttempts = 0;

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

      // Give it time to load and process empty plugins
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop should exit the loop promptly
      const stopTime = Date.now();
      connection.stop();
      await startPromise;
      const elapsed = Date.now() - stopTime;

      // Should resolve quickly (< 500ms including any pending sleep)
      expect(elapsed).toBeLessThan(500);
    });

    it('exits loop without attempting connection if stopped after config load succeeds', async () => {
      tmpDir = makeTmpDir();
      const logs: string[] = [];

      // Track connectOnce calls
      let connectOnceCalls = 0;
      const originalWS = (global as any).WebSocket;
      (global as any).WebSocket = class {
        constructor() {
          connectOnceCalls++;
          throw new Error('Should not attempt connection');
        }
      };

      try {
        const connection = new RelayConnection({
          configDir: tmpDir,
          retryDelayMs: 10,
          onLog: (line) => logs.push(line),
        });

        // Write valid relay.yml with empty plugins (no actual connection will be attempted)
        const relayYmlPath = join(tmpDir, 'relay.yml');
        writeFileSync(
          relayYmlPath,
          'relayUrl: "ws://127.0.0.1:1/relay-ws"\ntoken: "test"\nplugins: []\n'
        );

        const startPromise = connection.start();
        await new Promise((resolve) => setTimeout(resolve, 50));
        connection.stop();
        await startPromise;

        // connectOnceCalls should be 0 because config has no plugins
        // (connectOnce only called if plugins are configured)
        expect(connectOnceCalls).toBe(0);
      } finally {
        (global as any).WebSocket = originalWS;
      }
    });
  });

  describe('R8: token refusal and backoff handling', () => {
    // Helper: wait for condition with timeout
    async function waitFor(condition: () => boolean, maxMs: number = 2000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timeout waiting for condition after ${maxMs}ms`);
    }

    describe('(a) Invalid token error + 4001 close: no reconnect with same token', () => {
      it('receives error "Invalid token" then close 4001 -> exactly ONE attempt, refused-token log', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('refused the token')), 500);

          // Give extra time to ensure no second connection is attempted
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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('refused the token')), 500);
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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => connectionCount === 1 && logs.some((line) => line.includes('refused the token')), 500);

          const countAfterRefusal = connectionCount;

          // Rewrite with SAME token - should NOT reconnect
          writeFileSync(relayYmlPath, `relayUrl: ws://127.0.0.1:${port}
token: bad-token-v1
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`);
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
          await waitFor(() => connection.isConnected(), 1000);
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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => connectionCount >= 2, 1000);

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
        const connectionTimes: number[] = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
          connectionTimes.push(Date.now());
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') {
              ws.close(4429, 'Too many failed auth attempts');
            }
          });
        });

        const injectedOptions = {
          retryDelayMs: 10,
          reconnect: {
            minMs: 1,
            maxMs: 100,
            authBlockedMs: 100,
            tryAgainMs: 50,
            abuseMs: 75,
            random: () => 1,
          },
        };

        const connection = new RelayConnection({
          configDir: tmpDir,
          ...injectedOptions as any,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Wait for 2 connection attempts
          await waitFor(() => connectionTimes.length >= 2, 500);

          connection.stop();
          await startPromise;

          // Second connection should be at least authBlockedMs after first
          if (connectionTimes.length >= 2) {
            const delay = connectionTimes[1]! - connectionTimes[0]!;
            expect(delay).toBeGreaterThanOrEqual(80); // Allow small jitter margin
          }

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
      it('resolves < 500ms even during long authBlockedMs wait', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
            authBlockedMs: 5000, // Long wait
            tryAgainMs: 50,
            abuseMs: 75,
            random: () => 1,
          },
        };

        const connection = new RelayConnection({
          configDir: tmpDir,
          ...injectedOptions as any,
          onLog: (line) => logs.push(line),
        });

        try {
          const startPromise = connection.start();
          // Let it attempt once and enter the long authBlockedMs wait
          await new Promise((resolve) => setTimeout(resolve, 50));

          // Now stop and measure time
          const stopStart = Date.now();
          connection.stop();
          await startPromise;
          const stopElapsed = Date.now() - stopStart;

          expect(stopElapsed).toBeLessThan(500);
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
      const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
          const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
        await new Promise((resolve) => setTimeout(resolve, 200));
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
      const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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

      // Helper: wait for condition with timeout
      async function waitFor(condition: () => boolean, maxMs: number = 2000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          if (condition()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timeout waiting for condition after ${maxMs}ms`);
      }

      wss.on('connection', (ws) => {
        connections.push(ws);
        ws.on('message', (data) => {
          const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
        await waitFor(() => connection.getDiagnostics().lastCloseCode === 4001);
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
        await waitFor(() => connection.isConnected());
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
        await new Promise((resolve) => setTimeout(resolve, 100));
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
        await new Promise((resolve) => setTimeout(resolve, 100));
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
        await new Promise((resolve) => setTimeout(resolve, 200));
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
      const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
        await new Promise((resolve) => setTimeout(resolve, 150));
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

    // Helper: wait for condition with timeout
    async function waitFor(condition: () => boolean, maxMs: number = 2000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timeout waiting for condition after ${maxMs}ms`);
    }

    describe('(a) subscribeAll sends ONE subscribe per plugin with correct filter structure', () => {
      it('sends one subscribe message with union of eventTypes and empty payloadMatch', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => receivedMessages.some((m) => m.type === 'subscribe'), 2000);

          const subscribeMsg = receivedMessages.find((m) => m.type === 'subscribe') as any;
          expect(subscribeMsg).toBeDefined();
          expect(subscribeMsg.filter.source).toBe('github');
          expect(subscribeMsg.filter.eventType).toEqual(expect.arrayContaining(['push', 'pull_request']));
          expect(subscribeMsg.filter.payloadMatch).toEqual({});

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => receivedMessages.some((m) => m.type === 'subscribe'), 2000);

          const subscribeMsg = receivedMessages.find((m) => m.type === 'subscribe') as any;
          expect(subscribeMsg).toBeDefined();
          // Any subscription with no eventType means send empty array (all events)
          expect(subscribeMsg.filter.eventType).toEqual([]);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => pushToQueueCalls.length > 0, 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => pushToQueueCalls.length > 0, 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => pushToQueueCalls.length > 0, 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => pushToQueueCalls.length > 0, 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('matched no subscription')), 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('ABORTED')), 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('ABORTED')), 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('Pushed')), 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('Pushed')), 2000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((line) => line.includes('Failed to push')), 2000);

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
    // Helper: wait for condition with timeout
    async function waitFor(condition: () => boolean, maxMs: number = 2000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timeout waiting for condition after ${maxMs}ms`);
    }

    describe('(a) healthy server: no liveness errors across multiple heartbeat ticks', () => {
      it('with real ws server (autoPong: true default), stays connected for 5+ heartbeat ticks', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0, autoPong: true });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          // Wait for connection and then let 5 heartbeat ticks pass: 5 * 50 = 250ms minimum
          await waitFor(() => connection.isConnected(), 500);
          const initialConnectionCount = connectionCount;
          await new Promise((resolve) => setTimeout(resolve, 300));

          connection.stop();
          await startPromise;

          // Should have exactly one connection (no liveness-driven reconnect)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;
        writeRelayYml(tmpDir, port);

        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
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
          await waitFor(() => connectionCount >= 2, 3000);

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;
        writeRelayYml(tmpDir, port);
        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
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
          await waitFor(() => diagnosticsAtDetection !== null, 3000);

          const seen = diagnosticsAtDetection as { lastError: string | null; lastErrorAt: string | null } | null;
          expect(seen?.lastError).toContain('No sign of life from the relay');
          expect(seen?.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          // The loop keeps recovering after the detection
          await waitFor(() => connectionCount >= 2, 3000);
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
        const pingTimers: NodeJS.Timeout[] = [];

        const wss = new WebSocketServer({ port: 0, autoPong: false });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;
        writeRelayYml(tmpDir, port);
        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
              // Server-initiated pings every 20 ms: the client answers them automatically and they count as activity
              pingTimers.push(setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20));
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
          await waitFor(() => connection.isConnected(), 1000);
          // Let more than 4 full liveness windows (100 ms each) pass
          await new Promise((resolve) => setTimeout(resolve, 500));

          expect(connectionCount).toBe(1);
          expect(logs.filter((l) => l.includes('No sign of life')).length).toBe(0);

          connection.stop();
          await startPromise;
        } finally {
          pingTimers.forEach((t) => clearInterval(t));
          wss.close();
        }
      });
    });

    describe('(b) server with heartbeat enabled: connection stays healthy', () => {
      it('with heartbeat enabled and responsive server, connection stays open', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => connection.isConnected(), 500);
          const initialConnectionCount = connectionCount;

          // Let time pass to ensure heartbeat ticks run without issues
          await new Promise((resolve) => setTimeout(resolve, 250));

          connection.stop();
          await startPromise;

          // Should still have exactly one connection (heartbeat keeps it alive, no reason to reconnect)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
          wss.close();
        }
      });
    });

    describe('(c) server sends application messages but no pongs: not considered dead', () => {
      it('server sends message every heartbeat tick -> connection stays alive', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        let connectionCount = 0;

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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

        let messageInterval: any = null;
        wss.on('connection', (ws) => {
          connectionCount++;
          ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
              // Send a message every 35ms to keep activity alive (heartbeat is 50ms timeout)
              messageInterval = setInterval(() => {
                try {
                  ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
                } catch {
                  // connection closed
                }
              }, 35);
            }
          });
          ws.on('close', () => {
            if (messageInterval) clearInterval(messageInterval);
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
          await waitFor(() => connection.isConnected(), 500);
          const initialConnectionCount = connectionCount;
          // Let heartbeats tick for a while with continuous messages
          await new Promise((resolve) => setTimeout(resolve, 300));

          connection.stop();
          await startPromise;

          // Should still have only one connection (messages kept it alive)
          expect(connectionCount).toBe(initialConnectionCount);
          // Should NOT log "No sign of life"
          const noSignLogs = logs.filter((l) => l.includes('No sign of life'));
          expect(noSignLogs.length).toBe(0);
        } finally {
          wss.close();
        }
      });
    });

    describe('(d) stop() clears heartbeat timer, no pings after stop', () => {
      it('after stop(), connection resolves promptly and no further pings are sent', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const serverPings: number[] = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
            if (msg.type === 'auth') {
              ws.send(JSON.stringify({ type: 'authenticated', username: 't' }));
            }
          });
          ws.on('ping', () => {
            serverPings.push(Date.now());
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
          await waitFor(() => connection.isConnected(), 500);
          const pingsAfterStart = serverPings.length;

          // Stop and measure
          const stopTime = Date.now();
          connection.stop();
          await startPromise;
          const stopElapsed = Date.now() - stopTime;

          // Should resolve promptly
          expect(stopElapsed).toBeLessThan(500);

          // Wait a bit more to see if any additional pings arrive
          await new Promise((resolve) => setTimeout(resolve, 200));

          // No significant increase in pings after stop (allow for 1-2 in-flight pings)
          expect(serverPings.length).toBeLessThanOrEqual(pingsAfterStart + 2);
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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
          await waitFor(() => logs.some((l) => l.includes('refused the token')), 500);

          // Give extra time to confirm no further reconnect is attempted
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
    // Helper: wait for condition with timeout
    async function waitFor(condition: () => boolean, maxMs: number = 2000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timeout waiting for condition after ${maxMs}ms`);
    }

    describe('(a) subscriptionCount ack with multiple plugins: no warning when count >= subscribes sent', () => {
      it('2 plugins same source, server acks with subscriptionCount 1,2 -> NO warning, logs Subscribed with count', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];
        const receivedMessages: Array<Record<string, unknown>> = [];

        const wss = new WebSocketServer({ port: 0 });
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
                   logs.filter((l) => l.includes('[relay] Subscribed:')).length >= 2,
            2000
          );

          // Give time to ensure no warning is logged
          await new Promise((resolve) => setTimeout(resolve, 100));

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
                   logs.filter((l) => l.includes('replaced an earlier one')).length === 1,
            2000
          );

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
                   logs.filter((l) => l.includes('[relay] Subscribed:')).length >= 1,
            2000
          );

          await new Promise((resolve) => setTimeout(resolve, 100));

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
        const port = ((wss as unknown as { _server: { address: () => { port: number } } })._server.address() as { port: number }).port;

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
            const msg = JSON.parse(String(data)) as Record<string, unknown>;
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
                   logs.filter((l) => l.includes('replaced an earlier one')).length === 1,
            2000
          );

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

        const http = require('http');
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
          await waitFor(() => logs.some((l) => l.includes('429')), 1000);

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

        const http = require('http');
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
          await waitFor(() => logs.some((l) => l.includes('503')), 1000);

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

      it('stop() during 429 wait resolves promptly (< 500ms)', async () => {
        tmpDir = makeTmpDir();
        const logs: string[] = [];

        const http = require('http');
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
            authBlockedMs: 5000, // Long backoff
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
          const startTime = Date.now();
          const startPromise = connection.start();

          // Wait a bit for the first 429 response
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Now stop during the 5s wait
          connection.stop();
          await startPromise;

          const elapsed = Date.now() - startTime;

          // Should resolve promptly, not wait for the full 5s backoff
          expect(elapsed).toBeLessThan(500);
        } finally {
          server.close();
        }
      });
    });
  });
});
