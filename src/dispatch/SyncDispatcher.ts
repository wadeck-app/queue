import { CliTransport } from './CliTransport.js';
import { HttpTransport } from './HttpTransport.js';
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

  async dispatch(
    subscribers: ResolvedSubscriber[],
    envelope: EventEnvelope,
    timeoutMs: number
  ): Promise<SyncResult> {
    let currentPayload = envelope.payload;

    for (const sub of subscribers) {
      const currentEnvelope: EventEnvelope = { ...envelope, payload: currentPayload };

      let result;
      if (sub.type === 'cli') {
        if (!sub.command) {
          return { action: 'aborted', reason: `Subscriber ${sub.subscriberId} missing command` };
        }
        result = await this.cliTransport.dispatch(sub.command, currentEnvelope, timeoutMs);
      } else {
        if (!sub.url) {
          return { action: 'aborted', reason: `Subscriber ${sub.subscriberId} missing url` };
        }
        result = await this.httpTransport.dispatch(sub.url, sub.method ?? 'POST', sub.headers, currentEnvelope, timeoutMs);
      }

      if (!result.success) {
        if (result.error?.startsWith('timeout')) {
          return { action: 'aborted', reason: `subscriber timeout after ${Math.round(timeoutMs / 1000)}s` };
        }
        return { action: 'aborted', reason: result.error ?? 'dispatch failed' };
      }

      const stdout = result.stdout?.trim() ?? '';

      if (!stdout) {
        // Empty stdout → pass-through
        continue;
      }

      let parsed: SubscriberResponse;
      try {
        parsed = JSON.parse(stdout) as SubscriberResponse;
      } catch {
        return { action: 'aborted', reason: 'subscriber returned invalid JSON' };
      }

      if (parsed.action === 'abort') {
        return { action: 'aborted', reason: parsed.reason ?? 'aborted by subscriber' };
      }

      if (parsed.payload !== undefined) {
        currentPayload = parsed.payload;
      }
    }

    return { action: 'continue', payload: currentPayload };
  }
}
