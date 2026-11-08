import { listQueueSubscribers } from '@wadeck-app/queue-core';
import type { ResolvedSubscriber } from '@wadeck-app/queue-core';
import { isSameOrInside, loadRegistry, pathKey } from '@wadeck-app/project-sdk';
import { InvalidQueryError } from './errors.js';
import { maskCommand, maskUrl } from './maskSecrets.js';

/**
 * `?cwd=` is a request parameter, so it must not make this route read the subscribers.yml of any folder of the machine: it has to be the folder of a
 * registered project or lie below one. An unreadable registry throws.
 */
function assertKnownCwd(registryDir: string, cwd: string): void {
  const key = pathKey(cwd);
  const registry = loadRegistry(registryDir);
  if (registry.projects.some((project) => project.paths.some((entry) => isSameOrInside(pathKey(entry.path), key)))) {
    return;
  }
  throw new InvalidQueryError(
    `cwd ${JSON.stringify(cwd)} is not inside a registered project, so its subscribers are not shown. ` +
    `Fix: pass a folder of a registered project (queue project list shows them), or omit cwd to use the working directory of the dashboard process.`,
  );
}

const MASK = '***';

function maskValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  return record === undefined ? undefined : Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
}

// The settings of an action may hold anything (a token, a recipient, a message): every value is masked, whatever its type or depth
function maskWith(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
}

/**
 * Lists resolved subscribers (optionally filtered to one event) as configured in subscribers.yml for `cwd`.
 * Reads the configuration itself, so it works with the daemon stopped. Read-only: editing stays a `queue sub`
 * CLI operation to avoid a second source of truth. An invalid subscribers.yml throws.
 * The values of `headers`, `env` and the `with` of an action are masked: they hold tokens, and this answer travels over HTTP to a browser.
 *
 * `problem`: why the subscriber cannot run, as far as the files alone tell (a command of a virtual project that has no folder to run from). This module builds
 * its loader without the action plugins - it must not depend on queue-cli, which owns the built-in registry - so it cannot see the problems that need them
 * (an unknown action, a `with` block the plugin refuses): `queue sub list` and the daemon log report those.
 */
export type ListedSubscriber = ResolvedSubscriber & { problem?: string };

export function listSubscribers(configDir: string, cwd: string | undefined, event: string | undefined, registryDir: string): ListedSubscriber[] {
  // No cwd asked: the working directory of this process, as before. A cwd asked must lie in a registered project (see assertKnownCwd)
  const folder = cwd ?? process.cwd();
  if (cwd !== undefined) {
    assertKnownCwd(registryDir, cwd);
  }
  return listQueueSubscribers(configDir, { cwd: folder, event, registryDir }).map((subscriber) => {
    const problem = subscriber.configProblem ?? subscriber.cwdProblem;
    return {
      ...subscriber,
      ...(problem === undefined ? {} : { problem }),
      ...(subscriber.url === undefined ? {} : { url: maskUrl(subscriber.url) }),
      ...(subscriber.command === undefined ? {} : { command: maskCommand(subscriber.command) }),
      ...(subscriber.headers === undefined ? {} : { headers: maskValues(subscriber.headers) }),
      ...(subscriber.env === undefined ? {} : { env: maskValues(subscriber.env) }),
      ...(subscriber.with === undefined ? {} : { with: maskWith(subscriber.with) }),
    };
  });
}
