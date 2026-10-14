import { getErrorMessage } from '@wadeck-app/queue-core';
import type { RelayCommands } from '@wadeck-app/queue-relay-client';
import { join } from 'node:path';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';

export interface RelayStopIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/**
 * Stop the relay client with three distinct outcomes:
 * (a) Not running (idempotent) -> [ok], exit 0
 * (b) Running but quit fails -> [fail] with error + log hint, exit 1
 * (c) Success -> [ok], exit 0
 */
export async function relayStop(client: DaemonClient<RelayCommands>, configDir: string, io: RelayStopIO): Promise<number> {
  // Check if relay is currently running; if not, this is an idempotent stop (case a)
  const isRunning = await client.isRunning().catch(() => false);
  if (!isRunning) {
    // Deliberate: stopping a stopped relay is idempotent, not an error
    io.stderr.write('[ok] relay client was not running\n');
    return 0;
  }

  // Relay is running; attempt to stop it
  try {
    // 'quit' is a built-in daemon command; cast to bypass typing
    await (client.send as (cmd: string, payload?: unknown) => Promise<unknown>)('quit', undefined);
    // Success case (c)
    io.stdout.write('[ok] relay client stopped\n');
    return 0;
  } catch (err) {
    // Quit failed. Check if relay is still running: if it exited between our
    // isRunning() check above and now, treat as idempotent success (case a),
    // not a hard failure (case b).
    const stillRunning = await client.isRunning().catch(() => false);
    if (!stillRunning) {
      // Daemon exited between isRunning() and quit() — idempotent
      io.stderr.write('[ok] relay client was not running\n');
      return 0;
    }
    // Error case (b): relay is still running but quit failed
    const errorMsg = getErrorMessage(err);
    const logPath = join(configDir, 'relay-daemon', 'relay.log');
    io.stderr.write(`[fail] relay client did not stop: ${errorMsg}\n`);
    io.stderr.write(`       Check ${logPath} for details\n`);
    return 1;
  }
}
