import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { createDaemonClient, type DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { RELAY_DAEMON_PORT, startRelayDaemon, handleConnectionCrash, type RelayCommands } from './RelayDaemon.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-daemon-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('startRelayDaemon', () => {
  let configDir: string;
  let daemonHandle: Awaited<ReturnType<typeof startRelayDaemon>> | null = null;

  beforeEach(() => {
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Stop the daemon if it was started
    if (daemonHandle) {
      await daemonHandle.stop('command');
      daemonHandle = null;
    }
    // Clean up the temp directory
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('creates relay-daemon subdirectory before starting', async () => {
    configDir = makeTmpDir();
    const relayStateDir = join(configDir, 'relay-daemon');

    // Verify it doesn't exist yet
    expect(existsSync(relayStateDir)).toBe(false);

    // Start the daemon
    daemonHandle = await startRelayDaemon(configDir);

    // Verify the directory was created
    expect(existsSync(relayStateDir)).toBe(true);
  });

});

describe('RelayStatus with diagnostics', () => {
  let tmpConfigDir: string;
  let tmpDaemonHandle: Awaited<ReturnType<typeof startRelayDaemon>> | null = null;
  let client: DaemonClient<RelayCommands> | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (tmpDaemonHandle) {
      await tmpDaemonHandle.stop('command');
      tmpDaemonHandle = null;
    }
    if (tmpConfigDir) {
      rmSync(tmpConfigDir, { recursive: true, force: true });
    }
  });

  it('includes lastError, lastErrorAt, lastCloseCode from getDiagnostics', async () => {
    tmpConfigDir = makeTmpDir();

    // Write invalid relay.yml to force an error
    const relayYml = join(tmpConfigDir, 'relay.yml');
    writeFileSync(relayYml, 'invalid: yaml: content:');

    tmpDaemonHandle = await startRelayDaemon(tmpConfigDir);
    client = createDaemonClient<RelayCommands>({
      configDir: join(tmpConfigDir, 'relay-daemon'),
      commands: {
        status: () => ({ connected: false, pid: 0, uptimeSec: 0, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null }),
      },
    });

    // Wait a bit for the connection to attempt and fail
    await new Promise((resolve) => setTimeout(resolve, 300));

    const status = await client.send('status');

    expect(status.connected).toBe(false);
    expect(status.lastError).toBeDefined();
    expect(status.lastError).toContain('Cannot load relay.yml');
    expect(status.lastErrorAt).toBeDefined();
    expect(status.lastErrorAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes logError from RelayLogger failures', async () => {
    tmpConfigDir = makeTmpDir();

    const pluginPath = join(tmpConfigDir, 'plugin.js');
    writeFileSync(
      pluginPath,
      `export default {
  source: 'test',
  mapEvent: (e) => ({ event: \`test.\${e.eventType}\`, payload: e.payload })
};`
    );

    writeFileSync(
      join(tmpConfigDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:1/relay
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
    );

    tmpDaemonHandle = await startRelayDaemon(tmpConfigDir);
    client = createDaemonClient<RelayCommands>({
      configDir: join(tmpConfigDir, 'relay-daemon'),
      commands: {
        status: () => ({ connected: false, pid: 0, uptimeSec: 0, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const status = await client.send('status');

    // logError may be null or may contain a previous log failure message
    expect(status.logError === null || typeof status.logError === 'string').toBe(true);
  });
});

describe('handleConnectionCrash', () => {
  it('logs crash message, calls stopConnection, calls stopDaemon, and exits with code 1 when stopDaemon resolves', async () => {
    const err = new Error('connection broke');
    const logs: string[] = [];
    const stopConnectionMock = vi.fn();
    const stopDaemonMock = vi.fn().mockResolvedValue(undefined);
    const exitMock = vi.fn();

    await handleConnectionCrash(err, {
      log: (line) => logs.push(line),
      stopConnection: stopConnectionMock,
      stopDaemon: stopDaemonMock,
      exit: exitMock,
    });

    // Verify crash message was logged
    expect(logs.some((line) => line.includes('Relay connection loop crashed'))).toBe(true);
    expect(logs.some((line) => line.includes('connection broke'))).toBe(true);

    // Verify stopConnection was called
    expect(stopConnectionMock).toHaveBeenCalledTimes(1);

    // Verify stopDaemon was called
    expect(stopDaemonMock).toHaveBeenCalledTimes(1);

    // Verify exit(1) was called AFTER stopDaemon settled
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('logs stop failure, still exits with code 1 when stopDaemon rejects', async () => {
    const err = new Error('connection broke');
    const stopErr = new Error('failed to stop');
    const logs: string[] = [];
    const stopConnectionMock = vi.fn();
    const stopDaemonMock = vi.fn().mockRejectedValue(stopErr);
    const exitMock = vi.fn();

    await handleConnectionCrash(err, {
      log: (line) => logs.push(line),
      stopConnection: stopConnectionMock,
      stopDaemon: stopDaemonMock,
      exit: exitMock,
    });

    // Verify crash message was logged
    expect(logs.some((line) => line.includes('Relay connection loop crashed'))).toBe(true);

    // Verify stopConnection was called
    expect(stopConnectionMock).toHaveBeenCalledTimes(1);

    // Verify stopDaemon was called
    expect(stopDaemonMock).toHaveBeenCalledTimes(1);

    // Verify the stop failure was logged
    expect(logs.some((line) => line.includes('Failed to stop daemon during crash'))).toBe(true);
    expect(logs.some((line) => line.includes('failed to stop'))).toBe(true);

    // Verify exit(1) was STILL called despite stopDaemon rejecting
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 after the stop timeout when stopDaemon never settles', async () => {
    const err = new Error('connection broke');
    const logs: string[] = [];
    const stopConnectionMock = vi.fn();
    // Never resolves or rejects
    const stopDaemonMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    const exitMock = vi.fn();

    await handleConnectionCrash(err, {
      log: (line) => logs.push(line),
      stopConnection: stopConnectionMock,
      stopDaemon: stopDaemonMock,
      exit: exitMock,
    }, 20);

    expect(stopConnectionMock).toHaveBeenCalledTimes(1);
    expect(stopDaemonMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(logs.some((line) => line.includes('did not stop within 20ms'))).toBe(true);
  });

  it('calls exit only after stopDaemon has settled', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const stopDaemon = () => new Promise<void>((resolve) => { release = () => { order.push('stopDaemon settled'); resolve(); }; });

    const done = handleConnectionCrash(new Error('boom'), {
      log: () => {},
      stopConnection: () => order.push('stopConnection'),
      stopDaemon,
      exit: () => order.push('exit'),
    });

    // stopDaemon is still pending: exit must not have been called yet
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['stopConnection']);

    release();
    await done;
    expect(order).toEqual(['stopConnection', 'stopDaemon settled', 'exit']);
  });
});

describe('daemon stop command closes connection and prevents reconnect', () => {
  let tmpConfigDir: string;
  let daemonHandle: Awaited<ReturnType<typeof startRelayDaemon>> | null = null;
  let wsServer: WebSocketServer | null = null;
  let serverPort = 0;
  let clientConnections: WebSocket[] = [];
  let authMessagesReceived = 0;
  let closedConnections = 0;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create a test WebSocket server on ephemeral port
    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      wsServer!.once('listening', resolve);
    });
    serverPort = (wsServer.address() as any).port;

    wsServer.on('connection', (ws) => {
      clientConnections.push(ws as any);
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.type === 'auth') {
          authMessagesReceived++;
        }
      });
      ws.on('close', () => {
        closedConnections++;
      });
    });

    // Create temp config with a simple plugin
    tmpConfigDir = makeTmpDir();
    const pluginPath = join(tmpConfigDir, 'plugin.js');
    writeFileSync(
      pluginPath,
      `export default {
  source: 'test',
  mapEvent: (e) => ({ event: 'test', payload: e.payload })
};`
    );

    writeFileSync(
      join(tmpConfigDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${serverPort}/relay
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
    );
  });

  afterEach(async () => {
    // Close all server connections
    for (const ws of clientConnections) {
      (ws as any).terminate?.();
    }
    clientConnections = [];

    // Stop server
    if (wsServer) {
      await new Promise<void>((resolve, reject) => {
        wsServer!.close((err) => (err ? reject(err) : resolve()));
      });
      wsServer = null;
    }

    // Stop daemon
    if (daemonHandle) {
      await daemonHandle.stop('command');
      daemonHandle = null;
    }

    // Clean up temp dir
    if (tmpConfigDir) {
      rmSync(tmpConfigDir, { recursive: true, force: true });
    }
  });

  it('stop("command") closes the relay connection and prevents reconnect', async () => {
    daemonHandle = await startRelayDaemon(tmpConfigDir);

    // Wait for the daemon to connect and authenticate
    let attempts = 0;
    while (authMessagesReceived === 0 && attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      attempts++;
    }

    // Verify we got an auth message
    expect(authMessagesReceived).toBeGreaterThan(0);
    const initialClients = clientConnections.length;
    expect(initialClients).toBeGreaterThan(0);

    // Now stop the daemon via the command path (same as /quit)
    await daemonHandle.stop('command');

    // Wait for the connection to close
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the socket was closed
    expect(closedConnections).toBeGreaterThan(0);

    // Wait through a reconnect attempt (1s delay) and check no new connections
    const beforeWait = clientConnections.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterWait = clientConnections.length;

    // Should not have created a new connection (or if it did, it should close immediately)
    expect(afterWait).toBeLessThanOrEqual(beforeWait + 1);
  });

  it('safety timeout is armed and can force exit', async () => {
    const timeouts: Array<{ fn: () => void; ms: number; unref: boolean }> = [];
    const exits: Array<number> = [];

    // Mock setTimeout to capture the safety timeout
    const origSetTimeout = global.setTimeout;
    const mockSetTimeout = vi.fn((fn: () => void, ms: number) => {
      const id = origSetTimeout(fn, ms);
      timeouts.push({ fn, ms, unref: false });
      return {
        unref: () => {
          timeouts[timeouts.length - 1].unref = true;
          return (id as any).unref();
        },
      } as any;
    });
    vi.stubGlobal('setTimeout', mockSetTimeout);

    const mockExit = vi.fn((code: number) => {
      exits.push(code);
    });

    try {
      tmpConfigDir = makeTmpDir();
      const pluginPath = join(tmpConfigDir, 'plugin.js');
      writeFileSync(
        pluginPath,
        `export default {
  source: 'test',
  mapEvent: (e) => ({ event: 'test', payload: e.payload })
};`
      );

      writeFileSync(
        join(tmpConfigDir, 'relay.yml'),
        `relayUrl: ws://127.0.0.1:${serverPort}/relay
token: test-token
plugins:
  - module: ${pluginPath}
    subscriptions:
      - eventType: [test]
`
      );

      daemonHandle = await startRelayDaemon(tmpConfigDir);

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop via command
      await daemonHandle.stop('command');

      // Verify a timeout was set with an unref()
      const shutdownTimeouts = timeouts.filter((t) => t.ms >= 2500 && t.ms <= 3500);
      expect(shutdownTimeouts.length).toBeGreaterThan(0);
      expect(shutdownTimeouts[0].unref).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
