import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import type { ActionTransport } from './ActionTransport.js';
import type { RefResolver } from './refResolver.js';
import { runSubscriber, targetOf } from './runSubscriber.js';
import { OutputCapture } from './OutputCapture.js';
import { formatDuration } from './formatDuration.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import { projectRefsOf, type HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

export interface SyncResult {
  action: 'continue' | 'aborted';
  payload?: unknown;
  reason?: string;
}

interface SubscriberResponse {
  action?: 'abort' | 'continue';
  payload?: unknown;
  reason?: string;
}

export class SyncDispatcher {
  private readonly cliTransport = new CliTransport();
  private readonly httpTransport = new HttpTransport();

  constructor(
    // Required: the daemon has no usable stderr, an absent logger would make every failure invisible
    private readonly logger: QueueLogWriter,
    // Terse audit trail for `queue history`, written unconditionally unlike logger.logDispatch
    private readonly historyLog: HistoryWriter,
    // Absent: an action subscriber aborts the chain with a message that says no actions run in this process
    private readonly actionTransport?: ActionTransport,
    // Absent: no payload reference is followed in the templates of a cli subscriber
    private readonly refs?: RefResolver,
    // The clock of the budget, replaceable by tests
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `timeoutMs` is the time of the WHOLE before* event, as the push protocol says: the subscribers run one after the other and share it. Each one gets what is left
   * (the first one all of it); when nothing is left the chain aborts, naming the subscriber that did not run, instead of starting it with a fresh full timeout.
   */
  async dispatch(
    subscribers: ResolvedSubscriber[],
    envelope: EventEnvelope,
    timeoutMs: number
  ): Promise<SyncResult> {
    let currentPayload = envelope.payload;
    const startedAt = this.now();

    for (const [index, sub] of subscribers.entries()) {
      const currentEnvelope: EventEnvelope = { ...envelope, payload: currentPayload };
      const remainingMs = index === 0 ? timeoutMs : timeoutMs - (this.now() - startedAt);
      if (remainingMs <= 0) {
        return this.abort(envelope, sub, `the timeout of ${formatDuration(timeoutMs)} for the whole ${envelope.event} event was used up before subscriber ${sub.subscriberId} could run (the subscribers of a before* event share it, they run one after the other). Fix: raise the timeout of the push, or make the subscribers faster`);
      }

      const outcome = await runSubscriber(sub, currentEnvelope, remainingMs, { cli: this.cliTransport, http: this.httpTransport, action: this.actionTransport, refs: this.refs });
      if (outcome.kind === 'config') {
        return this.abort(envelope, sub, outcome.error);
      }
      const result = outcome.result;
      const target = targetOf(sub) ?? '';
      const captured = OutputCapture.forLog(result.success, result.stdout, result.stderr);

      if (!result.success) {
        const reason = result.error?.startsWith('timeout')
          ? `subscriber timeout after ${formatDuration(timeoutMs)}`
          : result.error ?? 'dispatch failed';
        return this.abort(envelope, sub, reason, target, result.durationMs, captured, result.detail);
      }

      const stdout = result.stdout?.trim() ?? '';

      if (stdout === '') {
        // Empty stdout: pass-through
        // A non-empty stderr on success is still recorded: it is often the only hint of a problem
        // An action's detail is always kept: it is the only trace of what the action did
        if (captured.stderr !== undefined || result.detail !== undefined) {
          this.logger.logDispatch({ event: envelope.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs, ...captured, ...(result.detail !== undefined && { detail: result.detail }) });
        }
        // History records every successful outcome, unlike logDispatch's noise-reduction above
        this.historyLog.logOutcome({ eventId: envelope.id, event: envelope.event, subscriberId: sub.subscriberId, status: 'success', target, ...projectRefsOf(envelope.meta) });
        continue;
      }

      let parsed: SubscriberResponse;
      try {
        parsed = JSON.parse(stdout) as SubscriberResponse;
      } catch {
        return this.abort(
          envelope,
          sub,
          'subscriber returned invalid JSON',
          target,
          result.durationMs,
          OutputCapture.forLog(false, result.stdout, result.stderr)
        );
      }

      if (parsed.action === 'abort') {
        this.historyLog.logOutcome({ eventId: envelope.id, event: envelope.event, subscriberId: sub.subscriberId, status: 'success', target, ...projectRefsOf(envelope.meta) });
        return { action: 'aborted', reason: parsed.reason ?? 'aborted by subscriber' };
      }

      if (captured.stderr !== undefined) {
        this.logger.logDispatch({ event: sub.event, subscriberId: sub.subscriberId, status: 'success', target, durationMs: result.durationMs, ...captured });
      }
      this.historyLog.logOutcome({ eventId: envelope.id, event: envelope.event, subscriberId: sub.subscriberId, status: 'success', target, ...projectRefsOf(envelope.meta) });

      if (parsed.payload !== undefined) {
        currentPayload = parsed.payload;
      }
    }

    return { action: 'continue', payload: currentPayload };
  }

  /** Aborts the chain and persists the reason with the subscriber output, not only to the caller. */
  private abort(
    envelope: EventEnvelope,
    sub: ResolvedSubscriber,
    reason: string,
    target?: string,
    durationMs?: number,
    captured: { stdout?: string; stderr?: string } = {},
    detail?: string,
  ): SyncResult {
    const resolvedTarget = target ?? targetOf(sub) ?? '';
    this.logger.logDispatch({
      event: envelope.event,
      subscriberId: sub.subscriberId,
      status: 'failed',
      target: resolvedTarget,
      durationMs,
      error: reason,
      ...captured,
      ...(detail !== undefined && { detail }),
    });
    this.historyLog.logOutcome({ eventId: envelope.id, event: envelope.event, subscriberId: sub.subscriberId, status: 'failed', target: resolvedTarget, ...projectRefsOf(envelope.meta) });
    return { action: 'aborted', reason };
  }
}
