import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
import type { ActionTransport } from './ActionTransport.js';
import { runSubscriber, targetOf } from './runSubscriber.js';
import { OutputCapture } from './OutputCapture.js';
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
  ) {}

  async dispatch(
    subscribers: ResolvedSubscriber[],
    envelope: EventEnvelope,
    timeoutMs: number
  ): Promise<SyncResult> {
    let currentPayload = envelope.payload;

    for (const sub of subscribers) {
      const currentEnvelope: EventEnvelope = { ...envelope, payload: currentPayload };

      const outcome = await runSubscriber(sub, currentEnvelope, timeoutMs, { cli: this.cliTransport, http: this.httpTransport, action: this.actionTransport });
      if (outcome.kind === 'config') {
        return this.abort(envelope, sub, outcome.error);
      }
      const result = outcome.result;
      const target = targetOf(sub) ?? '';
      const captured = OutputCapture.forLog(result.success, result.stdout, result.stderr);

      if (!result.success) {
        const reason = result.error?.startsWith('timeout')
          ? `subscriber timeout after ${Math.round(timeoutMs / 1000)}s`
          : result.error ?? 'dispatch failed';
        return this.abort(envelope, sub, reason, target, result.durationMs, captured);
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
    });
    this.historyLog.logOutcome({ eventId: envelope.id, event: envelope.event, subscriberId: sub.subscriberId, status: 'failed', target: resolvedTarget, ...projectRefsOf(envelope.meta) });
    return { action: 'aborted', reason };
  }
}
