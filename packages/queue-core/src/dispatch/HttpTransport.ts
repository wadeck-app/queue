import type { EventEnvelope } from '../types.js';
import type { DispatchResult } from './CliTransport.js';
import { getErrorMessage } from '../errors.js';

export class HttpTransport {
  async dispatch(
    url: string,
    method: string,
    headers: Record<string, string> | undefined,
    envelope: EventEnvelope,
    timeoutMs: number
  ): Promise<DispatchResult> {
    const start = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const text = await response.text();
      const durationMs = Date.now() - start;

      if (response.ok) {
        return { success: true, stdout: text, durationMs };
      }
      return { success: false, error: `HTTP ${response.status}`, stdout: text, durationMs };
    } catch (err) {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s`, durationMs };
      }
      return { success: false, error: getErrorMessage(err), durationMs };
    }
  }
}
