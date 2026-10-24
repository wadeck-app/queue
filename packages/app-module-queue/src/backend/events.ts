import { Ajv } from 'ajv';
import { getErrorMessage, getEventDetail, listEvents, listEventDetails, nearestEventNames, type CatalogEntry, type EventDetail, type EventListing, type PushResponse } from '@wadeck-app/queue-core';
import { InvalidPayloadError, InvalidQueryError, TestPayloadNotFoundError } from './errors.js';
import { pushEvent } from './push.js';
import { validateSingleString, type QueryParams } from './historyQuery.js';

export type EventStatus = 'declared' | 'undeclared';

export interface EventRow extends CatalogEntry {
  status: EventStatus;
  /** True when the row can be pushed as a test: declared, with an example payload. */
  canPushTest: boolean;
  /** The first sentence of the description, plain text: what fits a table cell (the whole description is `description`, Markdown). */
  descriptionExcerpt: string;
  /** When it was last pushed, ISO to the minute and UTC ("2026-10-24T11:55Z"), "-" when not seen within the observed window. */
  lastSeenText: string;
  /** Source, last seen, flags, schema, example, filterable paths and a wait command, pretty-printed: what the expanded row shows under the description. */
  detailsText: string;
}

export interface EventsResponse extends Omit<EventListing, 'events'> {
  events: EventRow[];
  /** The declared sources as { value, label } for the source select; whatever the filters. */
  sourceOptions: Array<{ value: string; label: string }>;
  /** One line per unreadable declaration file (file name and what is wrong), empty when all are readable: it drives the warning badge. */
  problemsText: string;
}

/** A parameter that was given and not empty (the page sends it empty when a control is cleared), once. */
function optionalString(query: QueryParams, name: string): string | undefined {
  const raw = query[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = validateSingleString(raw, name);
  return value === '' ? undefined : value;
}

function optionalBoolean(query: QueryParams, name: string): boolean | undefined {
  const value = optionalString(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'true' && value !== 'false') {
    throw new InvalidQueryError(`${name} must be true or false, got: "${value}"`);
  }
  return value === 'true';
}

function parseStatus(query: QueryParams): EventStatus | undefined {
  const value = optionalString(query, 'status');
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'declared' && value !== 'undeclared') {
    throw new InvalidQueryError(`status must be declared or undeclared, got: "${value}"`);
  }
  return value;
}

const EXCERPT_LENGTH = 110;

/** The one line of a description that fits a table cell: its first sentence, as plain text, cut at 110 characters. */
export function excerptOf(description: string | undefined): string {
  const firstLine = (description ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
  const plain = firstLine
    .replace(/^(#+|>|[-*])\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1');
  const end = /[.!?](\s|$)/.exec(plain);
  const sentence = end === null ? plain : plain.slice(0, end.index + 1);
  return sentence.length > EXCERPT_LENGTH ? `${sentence.slice(0, EXCERPT_LENGTH - 3).trimEnd()}...` : sentence;
}

function lastSeenTextOf(lastSeenAt: string | null): string {
  return lastSeenAt === null ? '-' : `${new Date(lastSeenAt).toISOString().slice(0, 16)}Z`;
}

function detailsTextOf(entry: CatalogEntry, detail: EventDetail | undefined): string {
  return JSON.stringify(
    {
      source: entry.source,
      lastSeenAt: entry.lastSeenAt,
      terminal: entry.terminal,
      outcome: entry.outcome,
      correlationKey: entry.correlationKey,
      schema: detail?.schema,
      example: detail?.example,
      filterable: detail?.filterable,
      waitExample: detail?.waitExample,
    },
    null,
    2,
  );
}

/** The event catalog joined with the history, filtered, one row per event ready for a DataTable. `nowMs` is for tests. */
export function getEvents(configDir: string, query: QueryParams, nowMs: number = Date.now()): EventsResponse {
  const source = optionalString(query, 'source');
  const prefix = optionalString(query, 'prefix');
  const match = optionalString(query, 'match');
  const declaredOnly = optionalBoolean(query, 'declaredOnly');
  const terminal = optionalBoolean(query, 'terminal');
  const status = parseStatus(query);
  const text = optionalString(query, 'q')?.toLowerCase();

  // One pass over the catalog and the history for the whole page: the detail of each row comes with the listing
  const { listing, details } = listEventDetails(configDir, {
    nowMs,
    ...(source !== undefined && { source }),
    ...(prefix !== undefined && { prefix }),
    ...(match !== undefined && { match }),
    ...(declaredOnly !== undefined && { declaredOnly }),
    ...(terminal !== undefined && { terminal }),
  });

  const rows: EventRow[] = [];
  for (const [index, entry] of listing.events.entries()) {
    const rowStatus: EventStatus = entry.declared ? 'declared' : 'undeclared';
    if (status !== undefined && status !== rowStatus) {
      continue;
    }
    if (text !== undefined && !entry.name.toLowerCase().includes(text) && !(entry.description ?? '').toLowerCase().includes(text)) {
      continue;
    }
    const detail: EventDetail | undefined = details[index];
    rows.push({
      ...entry,
      status: rowStatus,
      descriptionExcerpt: excerptOf(entry.description),
      lastSeenText: lastSeenTextOf(entry.lastSeenAt),
      canPushTest: entry.declared && detail?.example !== undefined,
      detailsText: detailsTextOf(entry, detail),
    });
  }

  return {
    events: rows,
    total: rows.length,
    sources: listing.sources,
    sourceOptions: listing.sources.map((summary) => ({ value: summary.source, label: summary.source })),
    problems: listing.problems,
    problemsText: listing.problems.map((problem) => `${problem.file}: ${problem.message}`).join(' | '),
  };
}

export interface PayloadValidation {
  valid: boolean;
  /** One line per problem: "payload.attempts: must be number"; the JSON parser message when the text is not JSON. */
  errors: string[];
  /** The one-line verdict the page shows. */
  message: string;
}

/** The declared event or the error a test push and a validation both start with. */
function declaredDetailOrThrow(configDir: string, name: string, purpose: string): NonNullable<ReturnType<typeof getEventDetail>> {
  const detail = getEventDetail(configDir, name);
  if (detail === undefined || !detail.entry.declared) {
    const declared = listEvents(configDir, { declaredOnly: true }).events.map((entry) => entry.name);
    const near = nearestEventNames(name, declared);
    throw new TestPayloadNotFoundError(
      `${name} is not declared by any program, so it has no ${purpose}${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}: ` +
        'the program that pushes it declares its events with queue.registerEvents (@wadeck-app/queue-sdk) or `queue events register`, or push it by hand with `queue push`',
    );
  }
  return detail;
}

function problemsOf(schema: Record<string, unknown>, payload: unknown): string[] {
  // strict: false, the schemas come from programs and may carry keywords this validator does not know
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (validate(payload)) {
    return [];
  }
  return (validate.errors ?? []).map((issue) => {
    const where = issue.instancePath === '' ? 'payload' : `payload${issue.instancePath.split('/').slice(1).map((part) => `.${part}`).join('')}`;
    return `${where}: ${issue.message ?? 'is invalid'}`;
  });
}

/** Checks the text of an edited example payload: valid JSON first, then the schema the event declares (when it declares one). */
export function validateEventPayload(configDir: string, name: string, payloadText: string): PayloadValidation {
  const detail = declaredDetailOrThrow(configDir, name, 'schema to validate against');
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch (err) {
    return { valid: false, errors: [`The text is not valid JSON: ${getErrorMessage(err)}`], message: 'Not valid JSON' };
  }
  if (detail.schema === undefined) {
    return { valid: true, errors: [], message: `Valid JSON; ${name} declares no schema, so nothing else was checked` };
  }
  const errors = problemsOf(detail.schema, payload);
  return errors.length === 0
    ? { valid: true, errors: [], message: 'The payload matches the schema' }
    : { valid: false, errors, message: `${errors.length} problem${errors.length === 1 ? '' : 's'} against the schema` };
}

/**
 * Pushes the declared example payload of an event through the daemon (or, with `payloadText`, the edited one, validated here again:
 * the page is not trusted): it runs the real subscribers of that event.
 */
export async function pushTestEvent(configDir: string, name: string, payloadText?: string): Promise<PushResponse> {
  if (payloadText !== undefined) {
    const verdict = validateEventPayload(configDir, name, payloadText);
    if (!verdict.valid) {
      throw new InvalidPayloadError(`The payload was not pushed: ${verdict.errors.join('; ')}`);
    }
    const parsed: unknown = JSON.parse(payloadText);
    return pushEvent(configDir, name, parsed);
  }
  const detail = declaredDetailOrThrow(configDir, name, 'example payload to push');
  if (detail.example === undefined) {
    throw new TestPayloadNotFoundError(
      `${name} declares no example payload: add an "example" to its declaration (queue.registerEvents in @wadeck-app/queue-sdk, or the file given to \`queue events register\`), or push it by hand with \`queue push ${name} '<json>'\``,
    );
  }
  return pushEvent(configDir, name, detail.example);
}

export interface EventPageResponse {
  found: boolean;
  /** Why nothing is shown (unknown name, no name), with the closest declared names; empty when found. */
  message: string;
  name: string;
  source: string;
  status: EventStatus;
  /** Markdown, as the program declared it. */
  description: string;
  count24h: number;
  lastSeenText: string;
  lastSeenAt: string | null;
  /** Empty when the declaration does not say (an unset flag is not "not terminal"). */
  terminalText: string;
  correlationKeyText: string;
  /** The compact facts of the page header, each empty when there is nothing to show. */
  sourceBadge: string;
  sourceHref: string;
  countBadge: string;
  lastSeenBadge: string;
  correlationBadge: string;
  hasSchema: boolean;
  schemaText: string;
  hasExample: boolean;
  exampleText: string;
  /** What to do when there is no example to show or push. */
  exampleHint: string;
  canPushTest: boolean;
  filterable: Array<{ path: string; type: string; requiredText: string }>;
  waitExample: string;
  /** Markdown code block of the wait command, for the page. */
  waitText: string;
  /** The dispatches of this event in the History page. */
  historyHref: string;
}

const NOT_FOUND: Omit<EventPageResponse, 'message' | 'name'> = {
  found: false,
  source: '',
  status: 'undeclared',
  description: '',
  count24h: 0,
  lastSeenText: '-',
  lastSeenAt: null,
  terminalText: '',
  correlationKeyText: '-',
  sourceBadge: '',
  sourceHref: '',
  countBadge: '',
  lastSeenBadge: '',
  correlationBadge: '',
  hasSchema: false,
  schemaText: '',
  hasExample: false,
  exampleText: '',
  exampleHint: '',
  canPushTest: false,
  filterable: [],
  waitExample: '',
  waitText: '',
  historyHref: '',
};

function terminalTextOf(entry: CatalogEntry): string {
  if (entry.terminal === true) {
    return entry.outcome === undefined ? 'terminal' : `terminal, outcome ${entry.outcome}`;
  }
  return entry.terminal === false ? 'not terminal' : '';
}

/** Everything the page of one event shows, split by part (description, flags, schema, example, filterable paths, wait command). */
export function getEventPage(configDir: string, name: string, nowMs: number = Date.now()): EventPageResponse {
  if (name === '') {
    return { ...NOT_FOUND, name, message: 'No event given: open this page from the Events list, or add ?name=<event name> to the address.' };
  }
  const detail = getEventDetail(configDir, name, nowMs);
  if (detail === undefined) {
    const known = listEvents(configDir, { nowMs }).events.map((entry) => entry.name);
    const near = nearestEventNames(name, known);
    return {
      ...NOT_FOUND,
      name,
      message: `'${name}' is not declared and was not pushed in the last 7 days${near.length > 0 ? `; did you mean ${near.join(', ')}?` : ''}`,
    };
  }
  const { entry } = detail;
  const hasExample = detail.example !== undefined;
  return {
    found: true,
    message: '',
    name: entry.name,
    source: entry.source ?? '',
    status: entry.declared ? 'declared' : 'undeclared',
    description: entry.description ?? '',
    count24h: entry.count24h,
    lastSeenText: lastSeenTextOf(entry.lastSeenAt),
    lastSeenAt: entry.lastSeenAt,
    terminalText: terminalTextOf(entry),
    correlationKeyText: entry.correlationKey === undefined || entry.correlationKey.length === 0 ? '-' : entry.correlationKey.join(', '),
    sourceBadge: entry.source === null ? '' : `source: ${entry.source}`,
    sourceHref: entry.source === null ? '' : `/modules/queue/events?source=${encodeURIComponent(entry.source)}`,
    countBadge: `${entry.count24h} pushed in 24 h`,
    lastSeenBadge: entry.lastSeenAt === null ? 'not seen in 7 days' : `last seen ${lastSeenTextOf(entry.lastSeenAt)}`,
    correlationBadge: entry.correlationKey === undefined || entry.correlationKey.length === 0 ? '' : `key: ${entry.correlationKey.join(', ')}`,
    hasSchema: detail.schema !== undefined,
    schemaText: detail.schema === undefined ? '' : JSON.stringify(detail.schema, null, 2),
    hasExample,
    exampleText: hasExample ? JSON.stringify(detail.example, null, 2) : '',
    exampleHint: hasExample
      ? ''
      : entry.declared
        ? 'This event declares no example payload: add an "example" to its declaration (queue.registerEvents in @wadeck-app/queue-sdk, or the file given to `queue events register`) to push a test from here.'
        : 'Nobody declared this event, so it has no example: the program that pushes it declares its events with queue.registerEvents (@wadeck-app/queue-sdk) or `queue events register`.',
    canPushTest: entry.declared && hasExample,
    filterable: detail.filterable.map((field) => ({ path: field.path, type: field.type, requiredText: field.required ? 'required' : 'optional' })),
    waitExample: detail.waitExample,
    waitText: `\`\`\`\n${detail.waitExample}\n\`\`\``,
    historyHref: `/modules/queue/history?event=${encodeURIComponent(entry.name)}`,
  };
}
