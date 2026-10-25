import { loadRegistry } from '@wadeck-app/project-sdk';

/**
 * The registered projects as the options of a dashboard select (History and DLQ filter by `project`): the id is the value, the name the label.
 * An unreadable registry throws: an empty list would hide the selector without saying why.
 */
export function listProjectOptions(registryDir: string): Array<{ value: string; label: string }> {
  return loadRegistry(registryDir)
    .projects.map((project) => ({ value: project.id, label: project.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
