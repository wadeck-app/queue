import { join } from 'node:path';
import { findProjectForPath, loadRegistry, projectToolDir } from '@wadeck-app/project-sdk';
import { getErrorMessage } from '@wadeck-app/queue-core';

export type SubscribersFile = { file: string; createDir?: boolean } | { error: string };

/**
 * The subscribers.yml `queue sub` reads and writes. `global`: the one of the queue config folder. `project`: the file of the config folder
 * of the registered project the working directory is in; outside every registered project there is none, which is an error
 * that says how to register the project (the old .queue/subscribers.yml is no longer read).
 */
export function subscribersFileFor(scope: 'global' | 'project', input: { configDir: string; cwd: string; registryDir: string }): SubscribersFile {
  if (scope === 'global') {
    return { file: join(input.configDir, 'subscribers.yml') };
  }
  let match;
  try {
    match = findProjectForPath(loadRegistry(input.registryDir), input.cwd);
  } catch (err) {
    return { error: `the project registry in ${input.registryDir} could not be read: ${getErrorMessage(err)}` };
  }
  if (match === undefined) {
    return { error: `${input.cwd} is not inside any registered project, so it has no project subscribers file (a .queue/subscribers.yml is no longer read). Fix: project add "${input.cwd}", or use --scope global` };
  }
  return { file: join(projectToolDir(input.registryDir, match.project.id, 'queue', 'config'), 'subscribers.yml'), createDir: true };
}
