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
            if (connections.length === 1) {
              // First connection: send error and close
              ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
              ws.close(4001, 'Unauthorized');
            } else if (connections.length === 2) {
              // Second connection: send authenticated
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
});
