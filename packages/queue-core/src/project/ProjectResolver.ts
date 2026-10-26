import { findProjectForPath, getConfigLayers, loadRegistry } from '@wadeck-app/project-sdk';
import type { ProjectConfigSource } from '../ConfigLoader.js';
import { getErrorMessage } from '../errors.js';

export interface EventProject {
  /** 8 lowercase hex characters, immutable: the key records carry. */
  id: string;
  name: string;
}

export type ProjectLookup =
  | { kind: 'registered'; project: EventProject; path: string }
  /** The cwd lies in no registered project: what applies (and what to do) is in `warning`. */
  | { kind: 'unregistered'; warning: string }
  /** The registry could not be read: `problem` says why and where. */
  | { kind: 'unavailable'; problem: string };

/**
 * Which registered project (project-sdk registry) a working directory belongs to. The registry is read at each lookup: the daemon
 * outlives `project add`, and a stale answer would keep warning about a project that is registered now.
 */
export class ProjectResolver {
  private readonly registryDir: string;

  constructor(registryDir: string) {
    this.registryDir = registryDir;
  }

  /** The project of a working directory (or of an explicit id) and, when it is registered, where its subscribers are kept. */
  resolve(cwd: string, projectId?: string): { lookup: ProjectLookup; source?: ProjectConfigSource } {
    const lookup = projectId !== undefined ? this.lookupId(projectId) : this.lookup(cwd);
    if (lookup.kind !== 'registered') {
      return { lookup };
    }
    const source = this.configSource(lookup.project.id);
    return { lookup, ...(source !== undefined && { source }) };
  }

  /** Where the subscribers of a registered project are kept: the config folders of the project and its ancestors, root first, each with the main folder of its project (the default cwd of its subscribers). */
  configSource(projectId: string): ProjectConfigSource | undefined {
    const registry = loadRegistry(this.registryDir);
    const project = registry.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return undefined;
    }
    const layers = getConfigLayers(registry, this.registryDir, project, 'queue').map((layer) => {
      const folder = layer.project.paths.find((path) => path.main)?.path ?? layer.project.paths[0]?.path;
      return { dir: layer.dir, projectId: layer.project.id, projectName: layer.project.name, ...(folder !== undefined && { folder }) };
    });
    return { projectId, layers };
  }

  /** A project named by its id (the explicit `project` of a push). `unregistered` here means: no project of that id. */
  lookupId(id: string): ProjectLookup {
    let registry;
    try {
      registry = loadRegistry(this.registryDir);
    } catch (err) {
      return { kind: 'unavailable', problem: `the project registry in ${this.registryDir} could not be read: ${getErrorMessage(err)}` };
    }
    const project = registry.projects.find((candidate) => candidate.id === id);
    if (project === undefined) {
      return { kind: 'unregistered', warning: `no registered project has the id '${id}'. Fix: project list shows the registered projects and their ids` };
    }
    return { kind: 'registered', project: { id: project.id, name: project.name }, path: project.paths.find((path) => path.main)?.path ?? '' };
  }

  lookup(cwd: string): ProjectLookup {
    let match;
    try {
      match = findProjectForPath(loadRegistry(this.registryDir), cwd);
    } catch (err) {
      return { kind: 'unavailable', problem: `the project registry in ${this.registryDir} could not be read: ${getErrorMessage(err)}` };
    }
    if (match === undefined) {
      return {
        kind: 'unregistered',
        warning:
          `the working directory ${cwd} is not inside any registered project: only the global subscribers apply ` +
          `(a .queue/subscribers.yml found above it is refused, not read). Fix: project add "${cwd}"`,
      };
    }
    return { kind: 'registered', project: { id: match.project.id, name: match.project.name }, path: match.path };
  }
}
