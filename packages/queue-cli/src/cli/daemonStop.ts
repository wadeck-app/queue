import { getErrorMessage } from '@wadeck-app/queue-core';

export interface DaemonStopIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/** The part of the daemon client `queue stop` needs. */
export interface StoppableDaemon {
  isRunning: () => Promise<boolean>;
  send: (command: 'quit', payload: undefined) => Promise<unknown>;
}

export const DAEMON_STOP_WAIT_MS = 5000;
const DAEMON_STOP_POLL_MS = 100;

/**
 * `queue stop` with outcomes whose message and exit code agree (the same three as `queue relay stop`):
 * (a) not running: idempotent, `[ok] daemon was not running`, exit 0;
 * (b) running and gone after the quit (also when the quit call itself threw because the daemon closed the connection): `[ok] daemon stopped`, exit 0;
 * (c) running and still running after the wait: `[fail]` with the error and where to look, exit 1.
 * Success is judged by the daemon being gone, never by the quit call alone.
 */
export async function daemonStop(
  client: StoppableDaemon,
  io: DaemonStopIO,
  options: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<number> {
  const waitMs = options.waitMs ?? DAEMON_STOP_WAIT_MS;
  const pollMs = options.pollMs ?? DAEMON_STOP_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  if (!(await client.isRunning().catch(() => false))) {
    io.stderr.write('[ok] daemon was not running\n');
    return 0;
  }
  let quitError: unknown;
  try {
    await client.send('quit', undefined);
  } catch (err) {
    quitError = err;
  }
  const deadline = now() + waitMs;
  for (;;) {
    if (!(await client.isRunning().catch(() => false))) {
      io.stdout.write('[ok] daemon stopped\n');
      return 0;
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(pollMs);
  }
  const why = quitError !== undefined ? `the quit request failed: ${getErrorMessage(quitError)}` : `it was still running after ${waitMs} ms`;
  io.stderr.write(`[fail] daemon did not stop: ${why}. Check 'queue logs' for the reason, then stop the process by hand (its pid is in 'queue status').\n`);
  return 1;
}
