export interface EventMeta {
  cwd: string;
  projectName?: string;
  /** Id of the registered project (project-sdk) the working directory belongs to; absent when it belongs to none. */
  projectId?: string;
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
  env?: Record<string, string>;
}
