import { getErrorMessage } from './errors.js';

// The push wire contract as the SDK sees it. Nothing read from the daemon is trusted: unknown fields are ignored, unknown
// status values are failures.

export interface PushRequest {
  event: string;
  payload: unknown;
  cwd: string;
  /** Request timeout in ms, only meaningful for `before*` events (the daemon dispatches them synchronously). */
  timeout?: number;
  /** The push protocol SemVer the client speaks. */
  protocol?: string;
}

export type PushStatus = 'dispatched' | 'queued' | 'aborted' | 'rejected';

export interface PushResponse {
  status: PushStatus;
  result?: unknown;
  reason?: string;
  subscriberCount?: number;
  eventId?: string;
  /** For `rejected`: the range of client protocol versions the daemon accepts. */
  supported?: string;
  warnings?: string[];
}

export interface PublishResult {
  status: 'queued' | 'dispatched' | 'dropped' | 'unknown';
  eventId?: string;
  result?: unknown;
  reason?: string;
}

export type ParsedAnswer = { ok: true; response: PushResponse } | { ok: false; reason: string };

const STATUSES: readonly string[] = ['dispatched', 'queued', 'aborted', 'rejected'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPushStatus(value: unknown): value is PushStatus {
  return typeof value === 'string' && STATUSES.includes(value);
}

function excerpt(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** Reads the `{ ok: true, result: PushResponse }` answer of POST /push. */
export function parsePushAnswer(body: unknown): ParsedAnswer {
  if (!isRecord(body) || body['ok'] !== true) {
    return { ok: false, reason: `unexpected push answer ${excerpt(body)}, expected { ok: true, result }` };
  }
  const result = body['result'];
  if (!isRecord(result)) {
    return { ok: false, reason: `push answer has no usable result: ${excerpt(body)}` };
  }
  const status = result['status'];
  if (!isPushStatus(status)) {
    return { ok: false, reason: `push answer has an unknown status ${excerpt(status)} (known: ${STATUSES.join(', ')}): the daemon is probably newer than this SDK, update @wadeck-app/queue-sdk` };
  }
  const response: PushResponse = { status };
  if ('result' in result) {
    response.result = result['result'];
  }
  if (typeof result['reason'] === 'string') {
    response.reason = result['reason'];
  }
  if (typeof result['subscriberCount'] === 'number') {
    response.subscriberCount = result['subscriberCount'];
  }
  if (typeof result['eventId'] === 'string') {
    response.eventId = result['eventId'];
  }
  if (typeof result['supported'] === 'string') {
    response.supported = result['supported'];
  }
  if (Array.isArray(result['warnings'])) {
    response.warnings = result['warnings'].filter((warning): warning is string => typeof warning === 'string');
  }
  return { ok: true, response };
}

/** Maps a daemon answer to what a caller of publishAndWait sees. `aborted` and `rejected` are not deliveries. */
export function toPublishResult(response: PushResponse): PublishResult {
  switch (response.status) {
    case 'dispatched': {
      return { status: 'dispatched', ...(response.eventId !== undefined && { eventId: response.eventId }), ...('result' in response && { result: response.result }) };
    }
    case 'queued': {
      return { status: 'queued', ...(response.eventId !== undefined && { eventId: response.eventId }) };
    }
    case 'aborted': {
      return { status: 'dropped', reason: response.reason ?? 'the daemon aborted the event (a before* subscriber refused it)' };
    }
    case 'rejected': {
      return { status: 'dropped', reason: response.reason ?? 'the daemon rejected the request' };
    }
  }
}

// JSON.stringify only throws on BigInt, cycles and a throwing toJSON. Finding which property is at fault is a second walk, done
// only on the failure path so the common path stays a single stringify.
function findUnserialisable(value: unknown, path: string, ancestors: unknown[]): string | undefined {
  if (typeof value === 'bigint') {
    return `${path} is a BigInt (convert it to a string or a number)`;
  }
  if (typeof value !== 'object' || value === null || typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return undefined;
  }
  if (ancestors.includes(value)) {
    return `${path} is a circular reference`;
  }
  const next = [...ancestors, value];
  const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, index): [string, unknown] => [`[${index}]`, item]) : Object.entries(value).map(([key, item]): [string, unknown] => [`.${key}`, item]);
  for (const [suffix, item] of entries) {
    const found = findUnserialisable(item, `${path}${suffix}`, next);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export type Serialized = { ok: true; body: string } | { ok: false; reason: string };

/** JSON body of a push, or the reason it cannot be built. Never throws. */
export function serializePushRequest(request: PushRequest): Serialized {
  if (request.payload === undefined) {
    return { ok: false, reason: 'payload is undefined, pass an object (or null) as the payload' };
  }
  try {
    const body = JSON.stringify(request);
    return { ok: true, body };
  } catch (error) {
    const culprit = findUnserialisable(request.payload, 'payload', []);
    return { ok: false, reason: `payload is not JSON-serialisable: ${culprit ?? getErrorMessage(error)}` };
  }
}
