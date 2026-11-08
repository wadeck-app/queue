import { findProjectIncludingDeleted } from '@wadeck-app/project-sdk';
import { InvalidQueryError, UnknownProjectError } from './errors.js';
import { assertProjectId } from './projects.js';

export interface ProjectCwd {
  cwd: string;
  projectName: string;
}

/**
 * The working directory to push from for a registered project: its main folder (else its first one). Subscribers limited to a project match
 * on the working directory of the push, so a push from the dashboard process (wherever app-core runs) never reaches them.
 * Malformed id => InvalidQueryError, unknown or removed project => UnknownProjectError, project without a folder => InvalidQueryError.
 */
export function resolveProjectCwd(registryDir: string, projectId: unknown): ProjectCwd {
  const id = assertProjectId(projectId);
  const found = findProjectIncludingDeleted(registryDir, id);
  if (found === undefined) {
    throw new UnknownProjectError(`No project with id ${id} in the registry; \`project list\` shows the registered ids`);
  }
  if (found.deleted) {
    throw new UnknownProjectError(`Project ${found.project.name} (${id}) was removed from the registry, so its subscribers no longer apply. Fix: pick a registered project (\`project list\`).`);
  }
  const folder = found.project.paths.find((entry) => entry.main) ?? found.project.paths[0];
  if (folder === undefined) {
    throw new InvalidQueryError(`Project ${found.project.name} (${id}) has no folder, so there is no working directory to push from. Fix: register a folder for it in the project tool, or pass "cwd" instead of "project".`);
  }
  return { cwd: folder.path, projectName: found.project.name };
}
