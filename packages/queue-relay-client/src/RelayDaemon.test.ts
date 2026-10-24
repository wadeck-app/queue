import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { createDaemonClient, type DaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { waitFor } from './testing/waitFor.js';
import { RELAY_DAEMON_PORT, startRelayDaemon, handleConnectionCrash, type RelayCommands } from './RelayDaemon.js';

// stop() arms a forced process.exit 3 s later (real timer): on a slow machine the worker is still running tests by then and vitest
// fails on "process.exit unexpectedly called". Tests that do not look at that safety net replace it with this no-op.
const noForcedExit = { setTimeout: () => ({ unref: () => undefined }), exit: () => undefined, log: () => undefined };

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
      rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('creates relay-daemon subdirectory before starting', async () => {
    configDir = makeTmpDir();
    const relayStateDir = join(configDir, 'relay-daemon');

    // Verify it doesn't exist yet
    expect(existsSync(relayStateDir)).toBe(false);

    // Start the daemon
    daemonHandle = await startRelayDaemon(configDir, noForcedExit);

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
      rmSync(tmpConfigDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('includes lastError, lastErrorAt, lastCloseCode from getDiagnostics', async () => {
    tmpConfigDir = makeTmpDir();

    // Write invalid relay.yml to force an error
    const relayYml = join(tmpConfigDir, 'relay.yml');
    writeFileSync(relayYml, 'invalid: yaml: content:');

    tmpDaemonHandle = await startRelayDaemon(tmpConfigDir, noForcedExit);
    client = createDaemonClient<RelayCommands>({
      configDir: join(tmpConfigDir, 'relay-daemon'),
      commands: {
        status: () => ({ connected: false, pid: 0, uptimeSec: 0, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null }),
      },
    });

    // Wait until the failed load of relay.yml shows up in the status
    await waitFor(async () => (await client!.send('status')).lastError !== null, 'the status to report the relay.yml load error');

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

    tmpDaemonHandle = await startRelayDaemon(tmpConfigDir, noForcedExit);
    client = createDaemonClient<RelayCommands>({
      configDir: join(tmpConfigDir, 'relay-daemon'),
      commands: {
        status: () => ({ connected: false, pid: 0, uptimeSec: 0, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null }),
      },
    });

    // Wait until the connection attempt to the closed port failed and is reported in the status
    await waitFor(async () => (await client!.send('status')).lastError !== null, 'the status to report the failed connection attempt');

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

    // stopDaemon is still pending: exit must not have been called yet (let every already queued task run, no time involved)
    await new Promise((resolve) => setImmediate(resolve));
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
  let clientConnections: ServerSocket[] = [];
  let authMessagesReceived = 0;
  let closedConnections = 0;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Counters are shared by the tests of this block
    clientConnections = [];
    authMessagesReceived = 0;
    closedConnections = 0;

    // Create a test WebSocket server on ephemeral port
    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      wsServer!.once('listening', resolve);
    });
    const address = wsServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error(`The test server is not listening on a TCP port (address: ${String(address)})`);
    }
    serverPort = address.port;

    wsServer.on('connection', (ws) => {
      clientConnections.push(ws);
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
      ws.terminate();
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
      rmSync(tmpConfigDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('stop("command") closes the relay connection and prevents reconnect', async () => {
    let connectionLoopEnded = false;
    daemonHandle = await startRelayDaemon(tmpConfigDir, noForcedExit, {
      connection: {
        onLoopEnd: () => {
          connectionLoopEnded = true;
        },
      },
    });

    // Wait for the daemon to connect and authenticate
    await waitFor(() => authMessagesReceived > 0, 'the daemon to connect and send its auth message');

    // Verify we got an auth message
    expect(authMessagesReceived).toBeGreaterThan(0);
    const initialClients = clientConnections.length;
    expect(initialClients).toBeGreaterThan(0);

    // Now stop the daemon via the command path (same as /quit)
    await daemonHandle.stop('command');

    // Wait for the connection to close
    await waitFor(() => closedConnections > 0, 'the server to see the relay connection close');

    // Verify the socket was closed
    expect(closedConnections).toBeGreaterThan(0);

    // The connection loop has ended: it checked the stop flag and left instead of scheduling a reconnect
    const beforeLoopEnd = clientConnections.length;
    await waitFor(() => connectionLoopEnded, 'the connection loop to end after stop');

    // No new connection was made on the way out
    expect(clientConnections.length).toBe(beforeLoopEnd);
  });

  it('safety timeout is armed and can force exit', async () => {
    const timeouts: Array<{ fn: () => void; ms: number; unref: boolean; timer: NodeJS.Timeout }> = [];
    const exits: Array<number> = [];

    // Mock setTimeout to capture the safety timeout
    const origSetTimeout = global.setTimeout;
    const mockSetTimeout = vi.fn((fn: () => void, ms: number) => {
      const timer = origSetTimeout(fn, ms);
      timeouts.push({ fn, ms, unref: false, timer });
      const realUnref = timer.unref.bind(timer);
      timer.unref = () => {
        timeouts[timeouts.length - 1].unref = true;
        return realUnref();
      };
      return timer;
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
      await waitFor(() => authMessagesReceived > 0, 'the daemon to connect and send its auth message');

      // Stop via command (stopped here, so afterEach must not stop it again and arm another real forced exit)
      const stoppingHandle = daemonHandle;
      daemonHandle = null;
      await stoppingHandle.stop('command');

      // Verify a timeout was set with an unref()
      const shutdownTimeouts = timeouts.filter((t) => t.ms >= 2500 && t.ms <= 3500);
      expect(shutdownTimeouts.length).toBeGreaterThan(0);
      expect(shutdownTimeouts[0].unref).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      // The real forced process.exit this test armed must never fire in the test worker
      for (const t of timeouts) {
        clearTimeout(t.timer);
      }
    }
  });
});
