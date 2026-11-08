import type { EventEnvelope } from '../types.js';
import type { DispatchResult } from './DispatchResult.js';
import { getErrorMessage } from '../errors.js';
import { formatDuration } from './formatDuration.js';

/** Most bytes read from the body of a response (1 MiB). A larger body fails the dispatch instead of filling the daemon's memory. */
export const MAX_HTTP_RESPONSE_BYTES = 1_048_576;

/** A body read stopped because it went over MAX_HTTP_RESPONSE_BYTES; `text` holds what was read before. */
class BodyTooLarge extends Error {
  constructor(readonly text: string) {
    super('body too large');
  }
}

/** Reads the body up to MAX_HTTP_RESPONSE_BYTES; throws BodyTooLarge beyond it. The abort signal of the request also ends this read (a stalled body). */
async function readBody(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > MAX_HTTP_RESPONSE_BYTES) {
      chunks.push(value.subarray(0, MAX_HTTP_RESPONSE_BYTES - total));
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(Buffer.concat(chunks).toString('utf-8'));
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Origin (scheme, host, port; never user info, path or query) a Location header points to, resolved against the request url; undefined when unusable. */
function redirectOrigin(location: string | null, url: string): string | undefined {
  if (location === null) {
    return undefined;
  }
  try {
    return new URL(location, url).origin;
  } catch {
    return undefined;
  }
}

export class HttpTransport {
  /**
   * The timeout covers the whole exchange, body included. Redirects are not followed: the custom headers (often an Authorization) and the envelope
   * would be forwarded to whatever origin the answer names; a 3xx is a failure that names that origin.
   */
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
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const origin = redirectOrigin(response.headers.get('location'), url);
        const where = origin === undefined ? 'to an address that could not be read' : `to ${origin}`;
        return {
          success: false,
          error:
            `HTTP ${response.status}: redirect ${where} not followed (the headers and the event would be sent to another address). ` +
            `Fix: set the url of the subscriber to the final address.`,
          durationMs: Date.now() - start,
        };
      }

      let text: string;
      try {
        text = await readBody(response);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          return {
            success: false,
            error: `HTTP ${response.status}: response body is larger than the limit of 1 MiB (${MAX_HTTP_RESPONSE_BYTES} bytes) and was not read further. Fix: make the endpoint answer with a short body.`,
            stdout: err.text,
            durationMs: Date.now() - start,
          };
        }
        throw err;
      }
      const durationMs = Date.now() - start;

      if (response.ok) {
        return { success: true, stdout: text, durationMs };
      }
      return { success: false, error: `HTTP ${response.status}`, stdout: text, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: `timeout after ${formatDuration(timeoutMs)}`, durationMs };
      }
      return { success: false, error: getErrorMessage(err), durationMs };
    } finally {
      clearTimeout(timer);
    }
  }
}
