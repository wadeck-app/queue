import * as fs from 'node:fs';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { spawnDetachedProcess } from '@wadeck-app/queue-core';
import type { QueueCommands, PushResponse } from '@wadeck-app/queue-core';

function createClient(configDir: string) {
  return createDaemonClient<QueueCommands>({ configDir, commands: {} as QueueCommands });
}

// Module-level map to track in-flight daemon starts per configDir
const inFlightStarts = new Map<string, Promise<void>>();

// Dependencies that can be injected for testing
interface EnsureDaemonRunningDeps {
  isRunning: (configDir: string) => Promise<boolean>;
  spawn: (entryPath: string, env: Record<string, string>) => void;
  resolveEntry: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

/**
 * Factory to create ensureDaemonRunning with injectable dependencies for testing.
 * Ensures only ONE daemon spawn per configDir even with concurrent callers.
 */
export function createEnsureDaemonRunning(deps: EnsureDaemonRunningDeps) {
  return async function ensureDaemonRunning(configDir: string): Promise<void> {
    // Closure to check if daemon is running for this configDir
    const checkIsRunning = () => deps.isRunning(configDir);

    // First check: if already running, return immediately
    if (await checkIsRunning().catch(() => false)) {
      return;
    }

    // Check if another caller is already starting the daemon for this configDir
    const existingPromise = inFlightStarts.get(configDir);
    if (existingPromise) {
      // Wait for the in-flight start to complete and resolve/reject
      return existingPromise;
    }

    // Create the start promise. Use a microtask to ensure the promise is stored
    // before any synchronous throws from resolveEntry() or spawn() execute finally.
    let startPromise: Promise<void>;

    // @formatter:off
    // Use Promise.resolve().then() to defer the work to the next microtask,
    // ensuring inFlightStarts.set() always runs before the finally block executes.
    // This prevents the race where synchronous throws run finally before set().
    // @formatter:on
    startPromise = Promise.resolve().then(async () => {
      try {
        // Resolve entry path lazily (only when actually starting)
        const entryPath = deps.resolveEntry();
        deps.spawn(entryPath, { QUEUE_CONFIG_DIR: configDir });

        // Poll for daemon to become running
        const deadline = deps.now() + deps.timeoutMs;
        while (deps.now() < deadline) {
          if (await checkIsRunning().catch(() => false)) {
            return;
          }
          await deps.sleep(200);
        }

        // Timeout reached
        throw new Error(
          `[queue-relay-client] Failed to start the queue daemon within ${deps.timeoutMs / 1000}s. Check ${configDir}/logs for the daemon diagnostics.`
        );
      } finally {
        // Remove the entry when promise settles (resolve or reject) so a later call can retry.
        // Only delete if this is still the stored promise (avoid race with newer start).
        if (inFlightStarts.get(configDir) === startPromise) {
          inFlightStarts.delete(configDir);
        }
      }
    });

    // Store the promise BEFORE it starts executing. The microtask ensures the finally
    // block won't run until after this set() completes.
    inFlightStarts.set(configDir, startPromise);

    // Return the promise so callers get the same one
    return startPromise;
  };
}

// Resolve the daemon script path from the QUEUE_DAEMON_SCRIPT environment variable.
// Called lazily at daemon start time to read process.env.
export function resolveDaemonScriptFromEnv(): string {
  const scriptPath = process.env.QUEUE_DAEMON_SCRIPT;

  if (!scriptPath) {
    throw new Error(
      `Cannot locate the queue daemon script to wake the daemon: QUEUE_DAEMON_SCRIPT is not set. Start the relay with 'queue relay start' (it passes the script path), or start the queue daemon yourself with 'queue start'.`
    );
  }

  // Check if the file exists
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `QUEUE_DAEMON_SCRIPT points to a file that does not exist: ${scriptPath}. Restart the relay with 'queue relay stop' then 'queue relay start'.`
    );
  }

  return scriptPath;
}

// Default dependencies using real implementations
const defaultDeps: EnsureDaemonRunningDeps = {
  isRunning: async (configDir: string) => {
    const client = createClient(configDir);
    return client.isRunning();
  },
  spawn: (entryPath: string, env: Record<string, string>) => {
    spawnDetachedProcess(entryPath, env);
  },
  resolveEntry: resolveDaemonScriptFromEnv,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs: 5_000,
};

// Export the main function with default dependencies
export const ensureDaemonRunning = createEnsureDaemonRunning(defaultDeps);

export async function pushToQueue(configDir: string, event: string, payload: unknown): Promise<PushResponse> {
  const client = createClient(configDir);
  return client.send('push', { event, payload, cwd: configDir });
}
