import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonHandle, ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { RelayConnection, type RelayConnectionOptions } from './RelayConnection.js';
import { createRelayLogger } from './RelayLogger.js';
import { relayStateDir } from './relayClient.js';
import { startIdleWatchdog, pinRelay, type IdleWatchdogOptions } from './onDemand.js';

export const RELAY_DAEMON_PORT = 47911;

export interface RelayStatus {
  connected: boolean;
  pid: number;
  uptimeSec: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastCloseCode: number | null;
  logError: string | null;
}

export type RelayCommands = {
  status: () => RelayStatus;
};

export interface ConnectionCrashDeps {
  log: (line: string) => void;
  stopConnection: () => void;
  stopDaemon: () => Promise<unknown>;
  exit: (code: number) => void;
}

const CRASH_STOP_TIMEOUT_MS = 5_000;

/**
 * Handle a connection crash by logging, stopping the connection and daemon,
 * and exiting the process with code 1. Guarantees exit: if the daemon fails to
 * stop, or does not settle within `stopTimeoutMs`, it exits anyway rather than
 * leaving a zombie daemon with a dead connection loop.
 */
export async function handleConnectionCrash(
  err: unknown,
  deps: ConnectionCrashDeps,
  stopTimeoutMs: number = CRASH_STOP_TIMEOUT_MS,
): Promise<void> {
  deps.log(`[relay] Relay connection loop crashed: ${getErrorMessage(err)}`);

  deps.stopConnection();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
  });
  // Promise.resolve().then() also turns a synchronous throw from stopDaemon into a rejection
  const stop = Promise.resolve()
    .then(() => deps.stopDaemon())
    .then(
      () => 'stopped' as const,
      (stopErr: unknown) => {
        deps.log(`[relay] Failed to stop daemon during crash: ${getErrorMessage(stopErr)}`);
        return 'failed' as const;
      },
    );

  const outcome = await Promise.race([stop, timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    deps.log(`[relay] Daemon did not stop within ${stopTimeoutMs}ms during crash; exiting anyway.`);
  }

  deps.exit(1);
}

export interface ShutdownDeps {
  setTimeout: (fn: () => void, ms: number) => { unref: () => void };
  exit: (code: number) => void;
  log: (line: string) => void;
}

/**
 * The relay client's own singleton daemon -- separate from QueueDaemon so it
 * can stay connected indefinitely (idleTimeout: null) without fighting the
 * main daemon's intentional 60s idle-shutdown. Uses a configDir subpath
 * ("relay-daemon") so its port-file never collides with the main daemon's,
 * which uses the same top-level QUEUE_CONFIG_DIR.
 */
export interface RelayDaemonOptions {
  /** Timing of the on-demand watchdog (see onDemand.ts); the defaults are the production ones. */
  idleWatchdog?: Pick<IdleWatchdogOptions, 'graceMs' | 'intervalMs' | 'onTick'>;
  // Exists for timing-free test assertions (see RelayConnectionOptions): hooks of the connection loop. Production never sets it.
  connection?: Pick<RelayConnectionOptions, 'sleep' | 'onLoopEnd'>;
}

export async function startRelayDaemon(configDir: string, shutdownDeps?: ShutdownDeps, options: RelayDaemonOptions = {}): Promise<DaemonHandle> {
  const stateDir = relayStateDir(configDir);
  // Ensure relay-daemon subdirectory exists before createDaemon tries to create config.lock
  mkdirSync(stateDir, { recursive: true });

  const startedAt = Date.now();
  // Create logger that writes to relay.log within the relay-daemon directory
  const relayLogger = createRelayLogger(join(stateDir, 'relay.log'));
  const connection = new RelayConnection({
    ...options.connection,
    configDir,
    onLog: (line) => {
      // Echo to both file and console for foreground runs
      relayLogger(line);
      console.log(line);
    },
  });

  // Use injected deps or real ones for shutdown
  const deps: ShutdownDeps = shutdownDeps || {
    setTimeout: (fn, ms) => {
      const id = globalThis.setTimeout(fn, ms);
      return { unref: () => { id.unref(); } };
    },
    exit: process.exit,
    log: (line) => relayLogger(line),
  };

  let watchdog: { cancel: () => void } | null = null;
  const daemonHandle = await createDaemon<RelayCommands>({
    configDir: stateDir,
    port: RELAY_DAEMON_PORT,
    idleTimeout: null,
    commands: {
      status: (): RelayStatus => {
        const diag = connection.getDiagnostics();
        return {
          connected: connection.isConnected(),
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          lastError: diag.lastError,
          lastErrorAt: diag.lastErrorAt,
          lastCloseCode: diag.lastCloseCode,
          logError: relayLogger.getLastError(),
        };
      },
    },
    // Hook into all shutdown paths (quit, idle, update, signal)
    hooks: {
      onShutdown: (reason) => {
        watchdog?.cancel();
        connection.stop();
        // Arm a safety timeout to force exit if shutdown takes too long
        // 3000ms gives the event loop time to drain after connection stops
        const timer = deps.setTimeout(() => {
          deps.log('[relay] forced exit after shutdown timeout');
          deps.exit(0);
        }, 3000);
        timer.unref();
      },
    },
  });

  // Started on demand by "queue wait": stop when nobody waits any more (a relay started by hand has no marker and is left alone)
  watchdog = startIdleWatchdog({
    relayDir: stateDir,
    ...options.idleWatchdog,
    log: (line) => relayLogger(line),
    stop: () => {
      // Stopped: no longer an on-demand relay waiting for its waiters, so leave no marker behind
      pinRelay(stateDir);
      connection.stop();
      void daemonHandle.stop('idle');
    },
  });

  // Start connection loop and handle any crashes
  void connection.start().catch((err) => {
    void handleConnectionCrash(err, {
      log: (line) => {
        relayLogger(line);
        console.error(line);
      },
      stopConnection: () => connection.stop(),
      stopDaemon: () => daemonHandle.stop('error'),
      exit: deps.exit,
    });
  });

  // Signal handlers: stop the connection, then let hooks.onShutdown handle daemon stop + exit
  const signalShutdown = (reason: ShutdownReason) => {
    connection.stop();
    void daemonHandle.stop(reason);
  };
  process.on('SIGINT', () => signalShutdown('signal'));
  process.on('SIGTERM', () => signalShutdown('signal'));

  return daemonHandle;
}
