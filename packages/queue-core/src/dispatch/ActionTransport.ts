import type { ActionContext, ActionResult } from '../actions/ActionPlugin.js';
import type { ActionRegistry } from '../actions/ActionRegistry.js';
import { getErrorMessage } from '../errors.js';
import type { EventEnvelope } from '../types.js';
import type { DispatchResult } from './DispatchResult.js';

/** Builds what a plugin may do for one run: bound to the envelope the subscriber received (the host decides project, working directory and loop counter). */
export type ActionContextFactory = (envelope: EventEnvelope) => ActionContext;

/** Runs a `type: action` subscriber in the daemon process. Reports like the other transports; never throws. */
export class ActionTransport {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly contextFor: ActionContextFactory,
  ) {}

  async dispatch(action: string, config: Record<string, unknown>, envelope: EventEnvelope, timeoutMs: number, subscriber: string): Promise<DispatchResult> {
    const start = Date.now();
    const plugin = this.registry.get(action);
    if (plugin === undefined) {
      return { success: false, permanent: true, error: `subscriber ${subscriber}: ${this.registry.unknownActionProblem(action)}`, durationMs: Date.now() - start };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const run = Promise.resolve().then(() => plugin.run(config, envelope, this.contextFor(envelope)));
      // If the timeout wins, the plugin keeps running (it cannot be cancelled): its late outcome must not become an unhandled rejection
      run.catch(() => undefined);
      const outcome = await Promise.race([run, timeout]);
      const durationMs = Date.now() - start;
      if (outcome === 'timeout') {
        return { success: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s (action '${action}', subscriber ${subscriber}); the action may still be running`, durationMs };
      }
      return this.toResult(outcome, action, subscriber, durationMs);
    } catch (err) {
      // A plugin that throws is a bug or an outage on its side, not a verdict on the event: retried, never permanent
      return { success: false, error: `action '${action}' threw (subscriber ${subscriber}): ${getErrorMessage(err)}`, durationMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
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
