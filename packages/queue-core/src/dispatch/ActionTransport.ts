import type { ActionContext, ActionResult } from '../actions/ActionPlugin.js';
import type { ActionRegistry } from '../actions/ActionRegistry.js';
import { getErrorMessage } from '../errors.js';
import type { EventEnvelope } from '../types.js';
import type { DispatchResult } from './DispatchResult.js';
import { EventRefError, type RefResolver } from './refResolver.js';

/**
 * Builds what a plugin may do for one run: bound to the envelope the subscriber received and to the id of that subscriber
 * (the host decides project, working directory, loop counter and provenance).
 */
export type ActionContextFactory = (envelope: EventEnvelope, subscriberId: string) => Omit<ActionContext, 'signal' | 'subscriber'>;

/** Prints a duration for a message: milliseconds under one second ("30ms"), seconds above ("1.2s", "30s"). */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
}

/** Runs a `type: action` subscriber in the daemon process. Reports like the other transports; never throws. */
export class ActionTransport {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly contextFor: ActionContextFactory,
    // Absent: an action renders its templates without following any payload reference
    private readonly refs?: RefResolver,
    // Where a refused late call of a superseded run is said (the daemon passes its log): absent, it is refused without a trace
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  async dispatch(action: string, config: Record<string, unknown>, envelope: EventEnvelope, timeoutMs: number, subscriber: string): Promise<DispatchResult> {
    const start = Date.now();
    const plugin = this.registry.get(action);
    if (plugin === undefined) {
      return { success: false, permanent: true, error: `subscriber ${subscriber}: ${this.registry.unknownActionProblem(action)}`, durationMs: Date.now() - start };
    }

    let timer: NodeJS.Timeout | undefined;
    const attempt = new AbortController();
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const run = Promise.resolve().then(() => plugin.run(config, envelope, this.contextForRun(envelope, subscriber, action, attempt.signal)));
      // If the timeout wins, the plugin keeps running (it cannot be cancelled): its late outcome must not become an unhandled rejection
      run.catch(() => undefined);
      const outcome = await Promise.race([run, timeout]);
      const durationMs = Date.now() - start;
      if (outcome === 'timeout') {
        // Before the caller schedules a retry: from here on the run can no longer push, so the retry is the only one that emits
        attempt.abort(new Error('timed out'));
        return { success: false, error: `timeout after ${formatDuration(timeoutMs)} (action '${action}', subscriber ${subscriber}); the action may still be running but can no longer push events`, durationMs };
      }
      return this.toResult(outcome, action, subscriber, durationMs);
    } catch (err) {
      // A plugin that throws is a bug or an outage on its side, not a verdict on the event: retried, never permanent
      return { success: false, error: `action '${action}' threw (subscriber ${subscriber}): ${getErrorMessage(err)}`, durationMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
      // Finished, failed or timed out: this run is over
      if (!attempt.signal.aborted) {
        attempt.abort(new Error('finished'));
      }
    }
  }

  /** The context of one run: the host's, plus the reference follower of this run (so a base event is loaded once per run). */
  private contextForRun(envelope: EventEnvelope, subscriber: string, action: string, signal: AbortSignal): ActionContext {
    const base = this.contextFor(envelope, subscriber);
    const supersededText = `superseded: the run of action '${action}' for subscriber ${subscriber} is over (timed out or finished), so it can no longer act`;
    const resolveRef = this.refs?.forEnvelope(envelope);
    return {
      ...base,
      signal,
      subscriber,
      push: (request) => {
        if (!signal.aborted) {
          return base.push(request);
        }
        this.onDiagnostic?.(`${supersededText}: its push of '${request.event}' was refused (the retry or the next run emits it). Fix: make the action stop on context.signal.`);
        return Promise.resolve({ success: false, error: `${supersededText}; its push of '${request.event}' was refused` });
      },
      ...(resolveRef !== undefined && {
        resolveRef: (ref, walked) => {
          if (signal.aborted) {
            throw new EventRefError(`${supersededText}; it can no longer read payload references`, ref, false);
          }
          return resolveRef(ref, walked);
        },
      }),
    };
  }

  private toResult(outcome: ActionResult, action: string, subscriber: string, durationMs: number): DispatchResult {
    if (typeof outcome !== 'object' || outcome === null || typeof outcome.success !== 'boolean') {
      return { success: false, error: `action '${action}' (subscriber ${subscriber}) returned a result that is not { success: boolean }; this is a bug in the plugin`, durationMs };
    }
    if (outcome.success) {
      // Empty stdout: the synchronous dispatcher reads stdout as the subscriber's JSON answer, an action never answers
      return { success: true, stdout: '', durationMs, ...(outcome.detail !== undefined && { detail: outcome.detail }) };
    }
    return {
      success: false,
      error: outcome.error ?? `action '${action}' failed without a reason (subscriber ${subscriber}); this is a bug in the plugin`,
      durationMs,
      ...(outcome.permanent === true && { permanent: true as const }),
      ...(outcome.detail !== undefined && { detail: outcome.detail }),
    };
  }
}
