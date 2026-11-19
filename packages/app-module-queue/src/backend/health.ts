import { closeSync, existsSync, openSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { getStatus } from './status.js';
import { listSubscribers } from './subscribers.js';
import { getWaiters } from './waiters.js';
import { listProjectOptions } from './projects.js';
import { getDaemonState } from './daemon.js';

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** The answer of `GET /health`, the update test of app-core-cli: `ok` is false when one check failed. */
export interface HealthAnswer {
  ok: boolean;
  checks: HealthCheck[];
}

/** How long the daemon is given to answer: it is informational here, a slow one must not hold the update test. */
const DAEMON_PROBE_MS = 2000;

/** Runs one read; a throw is the failed check, with the reason the page would have shown. */
function check(name: string, read: () => string): HealthCheck {
  try {
    return { name, ok: true, detail: read() };
  } catch (err) {
    return { name, ok: false, detail: getErrorMessage(err) };
  }
}

/**
 * The history folder can be listed and its newest day file opened. Not `listHistory`: it parses every day file (185 MB on a busy machine), which a check that runs while an
 * update waits cannot afford. A queue that never ran has no folder, which is healthy.
 */
function historyFolder(configDir: string): string {
  const folder = join(configDir, 'history');
  if (!existsSync(folder)) {
    return 'no history yet';
  }
  const days = readdirSync(folder).filter((name) => name.endsWith('.ndjson')).sort();
  const newest = days[days.length - 1];
  if (newest !== undefined) {
    closeSync(openSync(join(folder, newest), 'r'));
  }
  return `${days.length} day files`;
}

/**
 * Whether the module can do its job, with the same reads the pages do and nothing else: the queue files (WAL, DLQ), the history, `subscribers.yml`, the waiters folder and the
 * project registry. Read only, no side effect, no daemon needed (the pages read the files without it), so it takes milliseconds. The daemon is reported but never fails the
 * check: replay and retry need it, the dashboard does not, and a stopped daemon is a normal state of a machine.
 */
export async function getHealth(configDir: string, registryDir: string): Promise<HealthAnswer> {
  const checks: HealthCheck[] = [
    check('queue-files', () => {
      const status = getStatus(configDir);
      return `${status.pendingCount} pending, ${status.inFlightCount} in flight, ${status.dlqCount} in the DLQ`;
    }),
    check('history', () => historyFolder(configDir)),
    check('subscribers', () => {
      const subscribers = listSubscribers(configDir, undefined, undefined, registryDir);
      return `${subscribers.length} subscribers, ${subscribers.filter((subscriber) => subscriber.problem !== undefined).length} with a problem`;
    }),
    check('waiters', () => `${getWaiters(configDir).count} waiting`),
    check('projects', () => `${listProjectOptions(registryDir).length} registered`),
  ];
  const daemon = await Promise.race([getDaemonState(configDir), new Promise<null>((resolve) => setTimeout(() => resolve(null), DAEMON_PROBE_MS).unref())]).catch(() => null);
  checks.push({
    name: 'daemon',
    ok: true,
    detail: daemon === null ? `no answer within ${DAEMON_PROBE_MS} ms (not required by the dashboard)` : daemon.running ? 'running' : 'not running (replay and retry need it; not required by the dashboard)',
  });
  return { ok: checks.every((one) => one.ok), checks };
}
