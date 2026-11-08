export interface EventMeta {
  /** Where the event was emitted from. Absent for an event of a project that has no folder (virtual), pushed with `project` and no cwd. */
  cwd?: string;
  projectName?: string;
  /** Id of the registered project (project-sdk) the working directory belongs to; absent when it belongs to none. */
  projectId?: string;
  /** Set on the dispatch of a subscriber of a descendant project (push direction `to-children`): `projectId` is then the descendant's, this is the project the event was emitted in. */
  emitterProjectId?: string;
  /**
   * How many actions in a chain emitted this event (absent = 0, pushed by a client). Set only by the daemon's internal push, never read from the wire;
   * it survives the WAL, the DLQ, retry and dlq-replay. `queue replay` goes through the RPC push and starts again at 0.
   */
  hops?: number;
  /**
   * The first push of the chain of actions this event belongs to (absent on an event pushed by a client: it is its own root). Set only by the daemon's internal push, never
   * read from the wire; the per-root emission budget (MAX_ACTION_EMISSIONS_PER_ROOT) counts against it. It survives the WAL, the DLQ, retry and dlq-replay.
   */
  rootEventId?: string;
  /** Id of the push that created the event, set at the first push. The WAL id differs per subscriber, so `{{ id }}` of an action template renders this one: the same for every subscriber of the push, and kept by a retry and a dlq-replay (a `queue replay` is a new push, hence a new id). */
  eventId?: string;
  /**
   * `'queue'` on the events the daemon builds about itself (`queue.dlq.added`, ...). Set only by the daemon's internal push through an internal option,
   * never read from a wire request (a client-sent `origin` is ignored), like `hops`; it survives the WAL, the DLQ, retry and dlq-replay unchanged.
   * It is the condition under which a `$eventRef` of the payload is followed (see dispatch/refResolver.ts).
   */
  origin?: 'queue';
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
  type: 'cli' | 'http' | 'action';
  /** Name of the action plugin run in the daemon (type 'action' only). */
  action?: string;
  /** The configuration of the action, rendered and checked by the plugin (type 'action' only). */
  with?: Record<string, unknown>;
  /** Why this subscriber cannot run (e.g. an unknown action); the dispatch fails for good, straight to the DLQ, with this message. The other subscribers of the file are not affected. */
  configProblem?: string;
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
