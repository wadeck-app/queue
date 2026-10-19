import { isRecord } from '@wadeck-app/queue-core';
import type { RelayPlugin } from './plugin-api.js';
/**
 * REST API client for the relay webhook service.
 * Handles authentication, error handling with specific error kinds,
 * and timeout management.
 */

export class RelayApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: 'unauthorized' | 'blocked' | 'server' | 'network' | 'timeout' | 'protocol'
  ) {
    super(message);
    this.name = 'RelayApiError';
  }
}

export interface WebhookConfigInfo {
  id: string;
  source: string;
  name: string;
  createdAt: string;
  webhookUrl: string;
  // Absent on relays that do not report per-webhook statistics
  stats?: {
    verified24h: number;
    rejected24h: number;
    lastDeliveryAt: string | null;
    lastVerifiedAt: string | null;
  };
}

export interface DeliveryInfo {
  receivedAt: string;
  source: string;
  webhookConfigId: string;
  eventType: string;
  deliveryId: string;
  verified: boolean;
  error?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RelayApiClientOptions {
  relayUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface DeliveryQuery {
  limit?: number;
  eventType?: string;
  source?: string;
  verified?: boolean;
  includePayload?: boolean;
}

// Convert relay WebSocket URL to HTTP base URL
export function httpBaseFromRelayUrl(relayUrl: string): string {
  const parsed = new URL(relayUrl);
  const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const host = parsed.host; // Includes port if present
  return `${scheme}//${host}`;
}

export function createRelayApiClient(options: RelayApiClientOptions): {
  listWebhookConfigs(): Promise<WebhookConfigInfo[]>;
  listDeliveries(query?: DeliveryQuery): Promise<DeliveryInfo[]>;
} {
  const { relayUrl, token, fetch: customFetch = globalThis.fetch, timeoutMs = 10000 } = options;
  const httpBase = httpBaseFromRelayUrl(relayUrl);

  // Wrapper around fetch that adds timeout
  async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await customFetch(url, {
        ...opts,
        signal: controller.signal,
      });
      return response;
    } catch (err) {
      // Distinguish between timeout and network error
      const errName = isRecord(err) ? err.name : undefined;
      const errCode = isRecord(err) ? err.code : undefined;
      const errMsg = (err as Error).message || String(err);

      if (errName === 'AbortError' || errCode === 'ABORT_ERR') {
        throw new RelayApiError(
          `The relay did not answer within ${timeoutMs / 1000}s (${httpBase}).`,
          null,
          'timeout'
        );
      }

      throw new RelayApiError(
        `Cannot reach the relay at ${new URL(url).origin}: ${errMsg}`,
        null,
        'network'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function listWebhookConfigs(): Promise<WebhookConfigInfo[]> {
    const url = `${httpBase}/api/webhook-configs`;

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
    } catch (err) {
      if (err instanceof RelayApiError) {
        throw err;
      }
      // Should not reach here, but if it does, treat as network error
      throw new RelayApiError(
        `Cannot reach the relay at ${httpBase}: ${(err as Error).message}`,
        null,
        'network'
      );
    }

    // Handle HTTP error responses
    if (response.status === 401 || response.status === 403) {
      throw new RelayApiError(
        `The relay refused the token (HTTP ${response.status}). Fix QUEUE_RELAY_TOKEN; not retrying: every failed attempt counts against this machine's IP.`,
        response.status,
        'unauthorized'
      );
    }

    if (response.status === 429) {
      throw new RelayApiError(
        `The relay answered HTTP 429: this IP is blocked after too many failed authentications (about 10 minutes). Not retrying.`,
        429,
        'blocked'
      );
    }

    if (response.status >= 500) {
      throw new RelayApiError(
        `The relay answered HTTP ${response.status}.`,
        response.status,
        'server'
      );
    }

    if (!response.ok) {
      throw new RelayApiError(
        `The relay answered HTTP ${response.status}.`,
        response.status,
        'server'
      );
    }

    // Parse JSON response
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-configs: invalid JSON`,
        response.status,
        'protocol'
      );
    }

    // Validate response shape
    if (!isRecord(json)) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-configs: response is not an object`,
        response.status,
        'protocol'
      );
    }

    const obj = json;
    if (typeof obj.success !== 'boolean' || !obj.success) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-configs: missing success field`,
        response.status,
        'protocol'
      );
    }

    if (!Array.isArray(obj.configs)) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-configs: missing configs array`,
        response.status,
        'protocol'
      );
    }

    return obj.configs as WebhookConfigInfo[];
  }

  async function listDeliveries(query?: DeliveryQuery): Promise<DeliveryInfo[]> {
    const url = new URL(`${httpBase}/api/webhook-history`);

    // Add optional query parameters
    if (query?.limit !== undefined) {
      url.searchParams.set('limit', String(query.limit));
    }
    if (query?.eventType !== undefined) {
      url.searchParams.set('eventType', query.eventType);
    }
    if (query?.source !== undefined) {
      url.searchParams.set('source', query.source);
    }
    if (query?.verified !== undefined) {
      url.searchParams.set('verified', query.verified ? 'true' : 'false');
    }
    if (query?.includePayload === true) {
      url.searchParams.set('includePayload', '1');
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
    } catch (err) {
      if (err instanceof RelayApiError) {
        throw err;
      }
      throw new RelayApiError(
        `Cannot reach the relay at ${httpBase}: ${(err as Error).message}`,
        null,
        'network'
      );
    }

    // Handle HTTP error responses
    if (response.status === 401 || response.status === 403) {
      throw new RelayApiError(
        `The relay refused the token (HTTP ${response.status}). Fix QUEUE_RELAY_TOKEN; not retrying: every failed attempt counts against this machine's IP.`,
        response.status,
        'unauthorized'
      );
    }

    if (response.status === 429) {
      throw new RelayApiError(
        `The relay answered HTTP 429: this IP is blocked after too many failed authentications (about 10 minutes). Not retrying.`,
        429,
        'blocked'
      );
    }

    if (response.status >= 500) {
      throw new RelayApiError(
        `The relay answered HTTP ${response.status}.`,
        response.status,
        'server'
      );
    }

    if (!response.ok) {
      throw new RelayApiError(
        `The relay answered HTTP ${response.status}.`,
        response.status,
        'server'
      );
    }

    // Parse JSON response
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-history: invalid JSON`,
        response.status,
        'protocol'
      );
    }

    // Validate response shape
    if (!isRecord(json)) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-history: response is not an object`,
        response.status,
        'protocol'
      );
    }

    const obj = json;
    if (typeof obj.success !== 'boolean' || !obj.success) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-history: missing success field`,
        response.status,
        'protocol'
      );
    }

    if (!Array.isArray(obj.entries)) {
      throw new RelayApiError(
        `Unexpected response from /api/webhook-history: missing entries array`,
        response.status,
        'protocol'
      );
    }

    return obj.entries as DeliveryInfo[];
  }

  return {
    listWebhookConfigs,
    listDeliveries,
  };
}

/** Longest summary shown for a delivery. */
const MAX_SUMMARY_LENGTH = 110;

/**
 * One-line description of a delivery, written by the plugin of its source (RelayPlugin.summarize).
 * "(no summary)" when no plugin handles the source, the payload is not an object, or the plugin has nothing to say.
 */
export function summarizePayload(
  plugins: readonly RelayPlugin[],
  source: string,
  eventType: string,
  payload: Record<string, unknown> | null | undefined
): string {
  const plugin = plugins.find((candidate) => candidate.source === source);
  if (!plugin?.summarize || !isRecord(payload)) {
    return '(no summary)';
  }
  const summary = plugin.summarize(eventType, payload);
  if (summary === null || summary === '') {
    return '(no summary)';
  }
  return summary.length > MAX_SUMMARY_LENGTH ? summary.slice(0, MAX_SUMMARY_LENGTH - 3) + '...' : summary;
}
