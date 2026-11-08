import { getErrorMessage } from '@wadeck-app/queue-core';
import { relayStateDir } from '@wadeck-app/queue-relay-client/dist/relayClient.js';
import type { RelayCommands } from '@wadeck-app/queue-relay-client';
import { join } from 'node:path';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';

export interface RelayStopIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export const RELAY_STOP_WAIT_MS = 5000;
const RELAY_STOP_POLL_MS = 100;

/** Time sources and limits of the wait for the daemon to be gone; tests inject their own. */
export interface RelayStopOptions {
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stop the relay client with three distinct outcomes; success is judged by the daemon being gone, never by the quit call alone
 * (like `queue stop`):
 * (a) Not running (idempotent) -> [ok], exit 0
 * (b) Running and still running after the quit and the wait -> [fail] with error + log hint, exit 1
 * (c) Running and gone after the quit -> [ok], exit 0
 */
export async function relayStop(client: DaemonClient<RelayCommands>, configDir: string, io: RelayStopIO, options: RelayStopOptions = {}): Promise<number> {
  const waitMs = options.waitMs ?? RELAY_STOP_WAIT_MS;
  const pollMs = options.pollMs ?? RELAY_STOP_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Check if relay is currently running; if not, this is an idempotent stop (case a)
  const isRunning = await client.isRunning().catch(() => false);
  if (!isRunning) {
    // Deliberate: stopping a stopped relay is idempotent, not an error
    io.stderr.write('[ok] relay client was not running\n');
    return 0;
  }

  let quitError: unknown;
  try {
    // 'quit' is a built-in daemon command; cast to bypass typing
    await (client.send as (cmd: string, payload?: unknown) => Promise<unknown>)('quit', undefined);
  } catch (err) {
    // The daemon may close the connection while it exits: only the state afterwards decides
    quitError = err;
  }

  const deadline = now() + waitMs;
  for (;;) {
    if (!(await client.isRunning().catch(() => false))) {
      if (quitError === undefined) {
        io.stdout.write('[ok] relay client stopped\n');
      } else {
        // Exited between the isRunning() check and the quit: idempotent
        io.stderr.write('[ok] relay client was not running\n');
      }
      return 0;
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(pollMs);
  }

  const why = quitError !== undefined ? getErrorMessage(quitError) : `it was still running after ${waitMs} ms`;
  const logPath = join(relayStateDir(configDir), 'relay.log');
  io.stderr.write(`[fail] relay client did not stop: ${why}\n`);
  io.stderr.write(`       Check ${logPath} for details, then stop the process by hand (its pid is in 'queue relay status')\n`);
  return 1;
}
