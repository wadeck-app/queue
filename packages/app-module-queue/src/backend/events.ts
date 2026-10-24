import { getEventDetail, listEvents, listEventDetails, nearestEventNames, type CatalogEntry, type EventDetail, type EventListing, type PushResponse } from '@wadeck-app/queue-core';
import { InvalidQueryError, TestPayloadNotFoundError } from './errors.js';
import { pushEvent } from './push.js';
import { validateSingleString, type QueryParams } from './historyQuery.js';

export type EventStatus = 'declared' | 'undeclared';

export interface EventRow extends CatalogEntry {
  status: EventStatus;
  /** True when the row can be pushed as a test: declared, with an example payload. */
  canPushTest: boolean;
  /** Description, source, flags, schema, example, filterable paths and a wait command, pretty-printed: what the expanded row shows. */
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

function detailsTextOf(entry: CatalogEntry, detail: EventDetail | undefined): string {
  return JSON.stringify(
    {
      description: entry.description,
      source: entry.source,
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

/** Pushes the declared example payload of an event through the daemon: it runs the real subscribers of that event. */
export async function pushTestEvent(configDir: string, name: string): Promise<PushResponse> {
  const detail = getEventDetail(configDir, name);
  if (detail === undefined || !detail.entry.declared) {
    const declared = listEvents(configDir, { declaredOnly: true }).events.map((entry) => entry.name);
    const near = nearestEventNames(name, declared);
    throw new TestPayloadNotFoundError(
      `${name} is not declared by any program, so it has no example payload to push${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}: ` +
        'the program that pushes it declares its events with queue.registerEvents (@wadeck-app/queue-sdk) or `queue events register`, or push it by hand with `queue push`',
    );
  }
  if (detail.example === undefined) {
    throw new TestPayloadNotFoundError(
      `${name} declares no example payload: add an "example" to its declaration (queue.registerEvents in @wadeck-app/queue-sdk, or the file given to \`queue events register\`), or push it by hand with \`queue push ${name} '<json>'\``,
    );
  }
  return pushEvent(configDir, name, detail.example);
}
