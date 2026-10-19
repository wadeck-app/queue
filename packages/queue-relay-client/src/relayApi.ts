import { isRecord } from '@wadeck-app/queue-core';
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
      const errName = field(err, 'name');
      const errCode = field(err, 'code');
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

/** A property of an unknown JSON value; undefined unless the value is an object that has it. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Summarize a GitHub webhook payload into a human-readable string (max 110 chars).
 * Returns "(no summary)" if the payload shape is unknown.
 */
export function summarizePayload(
  source: string,
  eventType: string,
  payload: Record<string, unknown> | null | undefined
): string {
  if (!payload || typeof payload !== 'object') {
    return '(no summary)';
  }

  const parts: string[] = [];

  // Repository name
  const repo = field(field(payload, 'repository'), 'full_name');
  if (typeof repo === 'string') {
    parts.push(repo);
  }

  // Actor (sender login)
  const sender = field(field(payload, 'sender'), 'login');
  if (typeof sender === 'string') {
    parts.push(`by ${sender}`);
  }

  // Action
  const action = field(payload, 'action');
  if (typeof action === 'string') {
    parts.push(`action=${action}`);
  }

  // Branch/ref (strip refs/heads/ prefix)
  const ref = field(payload, 'ref');
  if (typeof ref === 'string') {
    parts.push(ref.startsWith('refs/heads/') ? ref.slice(11) : ref);
  }

  // Commit message first line
  const commitMsg = field(field(payload, 'head_commit'), 'message');
  if (typeof commitMsg === 'string') {
    const firstLine = commitMsg.split('\n')[0];
    parts.push(`"${firstLine}"`);
  }

  // Commits count
  const commits = field(payload, 'commits');
  if (Array.isArray(commits)) {
    parts.push(`${commits.length} commits`);
  }

  // Pull request number and title
  const pr = field(payload, 'pull_request');
  if (typeof pr === 'object' && pr !== null) {
    const num = field(pr, 'number');
    const title = field(pr, 'title');
    if (typeof num === 'number' && typeof title === 'string') {
      parts.push(`#${num} ${title}`);
    }
  }

  // Issue number and title
  const issue = field(payload, 'issue');
  if (typeof issue === 'object' && issue !== null) {
    const num = field(issue, 'number');
    const title = field(issue, 'title');
    if (typeof num === 'number' && typeof title === 'string') {
      parts.push(`#${num} ${title}`);
    }
  }

  // Workflow run name and conclusion
  const workflow = field(payload, 'workflow_run');
  if (typeof workflow === 'object' && workflow !== null) {
    const name = field(workflow, 'name');
    const conclusion = field(workflow, 'conclusion');
    if (typeof name === 'string' && typeof conclusion === 'string') {
      parts.push(`${name} ${conclusion}`);
    }
  }

  // Check run name and conclusion
  const checkRun = field(payload, 'check_run');
  if (typeof checkRun === 'object' && checkRun !== null) {
    const name = field(checkRun, 'name');
    const conclusion = field(checkRun, 'conclusion');
    if (typeof name === 'string' && typeof conclusion === 'string') {
      parts.push(`${name} ${conclusion}`);
    }
  }

  // Comment body (first 40 chars)
  const comment = field(field(payload, 'comment'), 'body');
  if (typeof comment === 'string') {
    const truncated = comment.length > 40 ? comment.slice(0, 40) + '…' : comment;
    parts.push(`comment: "${truncated}"`);
  }

  // Join all parts and truncate to 110 chars
  if (parts.length === 0) {
    return '(no summary)';
  }

  let summary = parts.join(' | ');
  if (summary.length > 110) {
    summary = summary.slice(0, 107) + '…';
  }

  return summary;
}
