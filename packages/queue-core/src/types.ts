export interface EventMeta {
  /** Where the event was emitted from. Absent for an event of a project that has no folder (virtual), pushed with `project` and no cwd. */
  cwd?: string;
  projectName?: string;
  /** Id of the registered project (project-sdk) the working directory belongs to; absent when it belongs to none. */
  projectId?: string;
  /** Set on the dispatch of a subscriber of a descendant project (push direction `to-children`): `projectId` is then the descendant's, this is the project the event was emitted in. */
  emitterProjectId?: string;
}

export interface EventEnvelope {
  id: string;
  timestamp: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
}

export interface ResolvedSubscriber {
  /** Stable identity stored in the WAL, DLQ, history and logs: '<name>' (global file) or '<project id>/<name>' (project file). */
  subscriberId: string;
  /** The 'name' of the subscriber in subscribers.yml (required). */
  name: string;
  /** Id and name of the registered project that owns the file (absent for the global file). */
  projectId?: string;
  projectName?: string;
  /** True when the project is a descendant of the emitter (push direction `to-children`): the dispatch is filed under that project. */
  fromDescendant?: true;
  /** The subscribers.yml it comes from, and whether that is the global one or the one of a project. */
  file: string;
  scope: 'global' | 'project';
  /** Where a project subscriber was found: the config folder of its registered project. */
  via?: 'registry';
  event: string;
  type: 'cli' | 'http';
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  retries: number;
  when?: string;
  timeoutMs: number;
  backoff: 'exponential' | 'linear';
  cwd?: string;
  /** Why a cli subscriber cannot run from any folder (it belongs to a virtual project and has no absolute cwd of its own); the dispatch fails with it. */
  cwdProblem?: string;
  env?: Record<string, string>;
}
