import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The relay client can be started on demand by `queue wait` instead of by hand. Nothing starts it at logon, so
 * something has to stop it when it is no longer useful: the relay stops itself once nobody has been waiting for a
 * while. The state is two things in the relay's own folder (<configDir>/relay-daemon):
 *  - `waiters/<pid>`: one file per running `queue wait` that may need the relay;
 *  - `on-demand`: present only when a wait started this relay. A relay started with `queue relay start` has no marker
 *    and is never stopped by this logic; a manual start of an on-demand relay removes the marker (pins it).
 * A wait that is killed without cleaning up (a stopped background task on Windows gets no chance to) leaves its file
 * behind: it is told apart by its dead pid.
 */

const WAITERS_DIR = 'waiters';
const ON_DEMAND_FILE = 'on-demand';

export const DEFAULT_IDLE_GRACE_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function registerWaiter(relayDir: string, pid: number = process.pid): void {
  const dir = join(relayDir, WAITERS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(pid)), new Date().toISOString());
}

export function unregisterWaiter(relayDir: string, pid: number = process.pid): void {
  rmSync(join(relayDir, WAITERS_DIR, String(pid)), { force: true });
}

/** Waiters whose process is alive; the files of dead ones are removed on the way. */
export function liveWaiterCount(relayDir: string, isAlive: (pid: number) => boolean = processIsAlive): number {
  const dir = join(relayDir, WAITERS_DIR);
  if (!existsSync(dir)) {
    return 0;
  }
  let live = 0;
  for (const name of readdirSync(dir)) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    if (isAlive(Number(name))) {
      live++;
    } else {
      rmSync(join(dir, name), { force: true });
    }
  }
  return live;
}

export function markOnDemand(relayDir: string): void {
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(join(relayDir, ON_DEMAND_FILE), new Date().toISOString());
}

/** Makes the relay permanent: it is no longer stopped when nobody waits. */
export function pinRelay(relayDir: string): void {
  rmSync(join(relayDir, ON_DEMAND_FILE), { force: true });
}

export function isOnDemand(relayDir: string): boolean {
  return existsSync(join(relayDir, ON_DEMAND_FILE));
}

export interface IdleWatchdogOptions {
  relayDir: string;
  /** How long nobody may wait before the relay stops. */
  graceMs?: number;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  stop: () => void;
  log: (line: string) => void;
  // Exists for timing-free test assertions: called at the end of every check, whatever its outcome, so a test can count the
  // checks that ran instead of waiting a duration. Production never sets it.
  onTick?: () => void;
}

/**
 * Runs inside the relay daemon: while the relay is on-demand and nobody has been waiting for `graceMs`, asks it to stop.
 * The grace period keeps the relay up between two waits that follow each other (an agent re-running `queue wait`).
 */
export function startIdleWatchdog(options: IdleWatchdogOptions): { cancel: () => void } {
  const graceMs = options.graceMs ?? DEFAULT_IDLE_GRACE_MS;
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? Date.now;
  let idleSince: number | null = null;

  const check = (): void => {
    if (!isOnDemand(options.relayDir) || liveWaiterCount(options.relayDir, isAlive) > 0) {
      idleSince = null;
      return;
    }
    idleSince ??= now();
    if (now() - idleSince >= graceMs) {
      clearInterval(timer);
      options.log(`[relay] no one is waiting for a relay event since ${Math.round(graceMs / 1000)}s, stopping (it was started on demand by "queue wait").`);
      options.stop();
    }
  };
  const timer = setInterval(() => {
    check();
    options.onTick?.();
  }, options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  // The watchdog alone must not keep a process alive
  timer.unref();

  return { cancel: () => clearInterval(timer) };
}
