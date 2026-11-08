import type { EventDeclaration } from '../catalog/EventCatalog.js';
import type { EventEnvelope } from '../types.js';
import type { ResolveRef } from '../walkPayloadPath.js';

/** The `with:` block of a `type: action` subscriber, as written in subscribers.yml (values are not rendered yet). */
export type ActionConfig = Record<string, unknown>;

/** Where a `with:` block is validated: names the subscriber so the plugin can say which one is wrong. */
export interface ActionValidationContext {
  /** The event pattern (key under `subscribers`) the subscriber listens to. */
  event: string;
  /** The `name` of the subscriber, absent when it has none yet (it is refused elsewhere). */
  name?: string;
}

/** An event an action wants to push. Where it comes from (project, working directory) and the loop counter are set by the daemon, never by the plugin. */
export interface ActionPushRequest {
  event: string;
  payload: unknown;
}

/** What the daemon answers to an action that pushed an event. */
export interface ActionPushResult {
  success: boolean;
  /** Id of the pushed event, when it was accepted. */
  eventId?: string;
  /** Why the event was not accepted: names the cause and what to change. */
  error?: string;
  /** The refusal cannot be fixed by trying again (loop cap, refused event name, oversized payload): no retry, straight to the DLQ. */
  permanent?: true;
}

/** What an action may do to the outside, handed to `run`. Bound to the envelope the subscriber received. */
export interface ActionContext {
  /**
   * Aborted when this run is over: the daemon timed it out (a retry may already be scheduled) or it returned. A plugin should stop its work when it aborts. A plugin that
   * ignores it is not left able to act: once aborted, `push` answers a refusal (`success: false`, error starting with "superseded:") and `resolveRef` throws,
   * so a late call of a timed-out run cannot emit the event twice (the retry emits it).
   */
  signal: AbortSignal;
  /** The id of the subscriber this run is for (`<name>`, or `<project id>/<name>` in a project file): pass it as the `subscriber` option of renderActionTemplate so `{{ subscriber }}` renders it. */
  subscriber: string;
  push(request: ActionPushRequest): Promise<ActionPushResult>;
  /**
   * Follows the payload references of the event the daemon built (`queue.dlq.*`) when the action renders its templates: pass it as the `resolveRef` option of
   * renderActionTemplate. Bound to this run (a base event is loaded once). Absent when the host follows none.
   */
  resolveRef?: ResolveRef;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** The failure would fail the same way again (a refused value, a bad configuration): no retry, straight to the DLQ. A plain failure is retried. */
  permanent?: true;
  /** A one-line trace of what was done on success. Logged by the dispatcher; it never reaches the subscriber's stdout. */
  detail?: string;
}

/**
 * An outbound plugin: what a `type: action` subscriber runs inside the daemon, instead of a command or an HTTP call
 * (the counterpart of the relay's inbound `RelayPlugin`). A plugin holds no state shared between runs: a run may be
 * repeated by a retry or a dlq-replay (delivery is at-least-once).
 */
export interface ActionPlugin {
  /** The value of `action:` in subscribers.yml. */
  name: string;
  /** Other names that select the same plugin. */
  aliases?: string[];
  /**
   * The events this plugin emits, with their documentation. The daemon files them in the event catalog at start, under the source `action-<name>`,
   * so `queue events list|show` and `queue wait` know them (the emitter declares its events, like any program that pushes events).
   */
  events?: readonly EventDeclaration[];
  /** Checks the `with:` block when the configuration is loaded. Returns the problem (what is wrong and what to write), or undefined when it is fine. Must not throw. */
  validate(config: ActionConfig, context: ActionValidationContext): string | undefined;
  /** The concrete event name this configuration pushes, when it is known without running (lets `queue sub add` warn about an undeclared event and detect loops). */
  emits?(config: ActionConfig): string | undefined;
  /** Runs once for one event. Reports a failure by returning it; a throw is treated as a retryable failure. */
  run(config: ActionConfig, envelope: EventEnvelope, context: ActionContext): Promise<ActionResult>;
}
