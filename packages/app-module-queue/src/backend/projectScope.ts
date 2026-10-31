import { findProjectIncludingDeleted } from '@wadeck-app/project-sdk';
import { PROJECT_ID_PATTERN } from './projects.js';

/** The answer of `GET /project-scope`: what the History and DLQ pages hand to the contributors of `queue:project-header`. */
export interface ProjectScope {
  /** The id asked for when it is well formed, otherwise an empty string. */
  id: string;
  /** Empty when the project was not found. */
  name: string;
  found: boolean;
}

/**
 * The project a page is scoped to by its `?project=` query. A header must never break the page, so a missing, repeated, malformed
 * or unregistered id answers `found: false`; a soft-deleted project is found (its records keep its id). An unreadable registry
 * throws: hiding the header without saying why would be silent.
 */
export function getProjectScope(registryDir: string, project: unknown): ProjectScope {
  if (typeof project !== 'string' || !PROJECT_ID_PATTERN.test(project)) {
    return { id: '', name: '', found: false };
  }
  const found = findProjectIncludingDeleted(registryDir, project);
  return found === undefined ? { id: project, name: '', found: false } : { id: project, name: found.project.name, found: true };
}
