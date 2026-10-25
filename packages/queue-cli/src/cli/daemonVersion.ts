import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { isRecord } from '@wadeck-app/queue-core';

/** How long the running daemon gets to answer GET /version: it is on this machine, a slow answer is a daemon in trouble, not a reason to hold a command. */
const ANSWER_TIMEOUT_MS = 2000;

/**
 * The queue release the running daemon reports (GET /version, no authentication), or undefined when there is no daemon to ask:
 * no port file, no answer, an answer that is not a version.
 */
export async function readDaemonVersion(configDir: string): Promise<string | undefined> {
  let port: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, 'config.port'), 'utf-8'));
    port = isRecord(parsed) ? parsed['port'] : undefined;
  } catch {
    return undefined;
  }
  if (typeof port !== 'number') {
    return undefined;
  }
  return new Promise<string | undefined>((resolve) => {
    const request = get({ host: '127.0.0.1', port, path: '/version', timeout: ANSWER_TIMEOUT_MS }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(body);
          resolve(response.statusCode === 200 && isRecord(parsed) && typeof parsed['version'] === 'string' ? parsed['version'] : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(undefined); });
    request.on('error', () => resolve(undefined));
  });
}

/**
 * The warning for a daemon that runs another release than this CLI: a `queue cli update` replaces the files, not the long-running
 * daemon, so it keeps the old code (where it reads its configuration, what it records) until it is restarted. Undefined when both run
 * the same release, when the daemon's version is unknown, or when either is a dev build (a dev build never matches).
 */
export function versionMismatchWarning(daemonVersion: string | undefined, cliVersion: string): string | undefined {
  if (daemonVersion === undefined || daemonVersion === cliVersion || !isReleaseVersion(daemonVersion) || !isReleaseVersion(cliVersion)) {
    return undefined;
  }
  return (
    `the daemon runs ${daemonVersion} but this CLI is ${cliVersion}: an update replaces the CLI, not the daemon that is already running, so it still has the old code. ` +
    'Fix: queue stop (the next command starts the new daemon; events not delivered yet stay in the WAL and are retried)'
  );
}
