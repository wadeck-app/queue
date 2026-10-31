import { loadRegistry } from '@wadeck-app/project-sdk';
import { InvalidQueryError } from './errors.js';

/**
 * The registered projects as the options of a dashboard select (History and DLQ filter by `project`): the id is the value, the name the label.
 * An unreadable registry throws: an empty list would hide the selector without saying why.
 */
export function listProjectOptions(registryDir: string): Array<{ value: string; label: string }> {
  return loadRegistry(registryDir)
    .projects.map((project) => ({ value: project.id, label: project.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The id of a registered project: 8 lowercase hexadecimal characters. */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Throws the 400 message every route that takes a project id shares (`/dlq`, `/related/project/:projectId`). */
export function assertProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new InvalidQueryError(`project must be the id of a registered project (8 hexadecimal characters, project list shows them), got: ${JSON.stringify(value)}`);
  }
  return value;
}
