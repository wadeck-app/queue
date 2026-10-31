import { join } from 'node:path';
import { HistoryReader } from '../storage/HistoryReader.js';
import { EventMatcher } from '../dispatch/EventMatcher.js';
import { isRecord } from '../isRecord.js';
import { readCatalog, type Catalog, type EventDeclaration, type EventOutcome } from './EventCatalog.js';

// The read model of the event catalog, shared by the dashboard and the CLI: what each program declared, joined with what really
// happened in the history (a declaration can lie or be missing, the history cannot). Reads files only.

const DAY_MS = 24 * 3_600_000;
/** How far back the history is searched for events nobody declared, and for the last time a declared one was pushed. */
export const OBSERVED_WINDOW_DAYS = 7;

export interface CatalogEntry {
  name: string;
  /** The program that declared it; null for a name only seen in the history. */
  source: string | null;
  declared: boolean;
  description?: string;
  terminal?: boolean;
  outcome?: EventOutcome;
  correlationKey?: string[];
  hasSchema: boolean;
  /** Pushes in the last 24 hours. */
  count24h: number;
  /** ISO time of the last push within the observed window, null when none. */
  lastSeenAt: string | null;
  /** When its source last declared its events. */
  registeredAt?: string;
}

export interface SourceSummary {
  source: string;
  registeredAt: string;
  eventCount: number;
}

export interface EventListing {
  events: CatalogEntry[];
  /** Number of `events`, after the filters. */
  total: number;
  sources: SourceSummary[];
  /** Declaration files that could not be read. */
  problems: Catalog['problems'];
}

export interface ListEventsOptions {
  nowMs?: number;
  source?: string;
  /** Names that start with this text. */
  prefix?: string;
  /** A subscribers.yml pattern: `*` is one segment, `>` the rest (`**` is an alias). */
  match?: string;
  declaredOnly?: boolean;
  /** Only the events that end the thing they are about. */
  terminal?: boolean;
}

function activityOf(configDir: string, nowMs: number): Map<string, { count: number; recentCount: number; lastSeenMs: number }> {
  return new HistoryReader(join(configDir, 'history')).eventActivity(nowMs, OBSERVED_WINDOW_DAYS * DAY_MS, DAY_MS);
}

function allEntries(configDir: string, nowMs: number): { entries: CatalogEntry[]; catalog: Catalog } {
  const catalog = readCatalog(configDir);
  const activity = activityOf(configDir, nowMs);
  const declaredNames = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const source of catalog.sources) {
    for (const event of source.events) {
      declaredNames.add(event.name);
      const seen = activity.get(event.name);
      entries.push({
        name: event.name,
        source: source.source,
        declared: true,
        description: event.description,
        ...(event.terminal !== undefined && { terminal: event.terminal }),
        ...(event.outcome !== undefined && { outcome: event.outcome }),
        ...(event.correlationKey !== undefined && { correlationKey: event.correlationKey }),
        hasSchema: event.schema !== undefined,
        count24h: seen?.recentCount ?? 0,
        lastSeenAt: seen === undefined ? null : new Date(seen.lastSeenMs).toISOString(),
        registeredAt: source.registeredAt,
      });
    }
  }
  entries.sort((a, b) => (a.source ?? '').localeCompare(b.source ?? '') || a.name.localeCompare(b.name));
  const undeclared = [...activity.entries()]
    .filter(([name]) => !declaredNames.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, seen]): CatalogEntry => ({ name, source: null, declared: false, hasSchema: false, count24h: seen.recentCount, lastSeenAt: new Date(seen.lastSeenMs).toISOString() }));
  return { entries: [...entries, ...undeclared], catalog };
}

function applyFilters(entries: CatalogEntry[], options: ListEventsOptions): CatalogEntry[] {
  return entries.filter(
    (entry) =>
      (options.source === undefined || entry.source === options.source) &&
      (options.prefix === undefined || entry.name.startsWith(options.prefix)) &&
      (options.match === undefined || EventMatcher.matches(options.match, entry.name)) &&
      (options.declaredOnly !== true || entry.declared) &&
      (options.terminal !== true || entry.terminal === true),
  );
}

function listingOf(entries: CatalogEntry[], catalog: Catalog): EventListing {
  return {
    events: entries,
    total: entries.length,
    sources: catalog.sources.map((source) => ({ source: source.source, registeredAt: source.registeredAt, eventCount: source.events.length })),
    problems: catalog.problems,
  };
}

/** The declared events joined with the history, filtered. Sorted by source then name, the undeclared ones last. */
export function listEvents(configDir: string, options: ListEventsOptions = {}): EventListing {
  const { entries, catalog } = allEntries(configDir, options.nowMs ?? Date.now());
  return listingOf(applyFilters(entries, options), catalog);
}

export interface FilterableField {
  /** Dotted path for `queue wait --when`: `payload.jobId`. */
  path: string;
  type: string;
  required: boolean;
}

export interface EventDetail {
  entry: CatalogEntry;
  schema?: Record<string, unknown>;
  example?: unknown;
  /** The payload paths `queue wait --when` can filter on, read from the schema. */
  filterable: FilterableField[];
  /** A command that waits for this event, ready to adapt. */
  waitExample: string;
}

const MAX_SCHEMA_DEPTH = 4;

function flatten(schema: unknown, prefix: string, depth: number): FilterableField[] {
  if (!isRecord(schema) || !isRecord(schema['properties']) || depth > MAX_SCHEMA_DEPTH) {
    return [];
  }
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : [];
  const fields: FilterableField[] = [];
  for (const [key, property] of Object.entries(schema['properties'])) {
    const type = isRecord(property) && typeof property['type'] === 'string' ? property['type'] : 'unknown';
    if (type === 'object') {
      fields.push(...flatten(property, `${prefix}.${key}`, depth + 1));
    } else {
      fields.push({ path: `${prefix}.${key}`, type, required: required.includes(key) });
    }
  }
  return fields;
}

function waitExampleFor(name: string, correlationKey: string[] | undefined): string {
  const when = correlationKey?.[0];
  return when === undefined ? `queue wait ${name} --since 5m --json` : `queue wait ${name} --when "${when}=<${when.split('.').pop()}>" --since 5m --json`;
}

function detailOf(entry: CatalogEntry, catalog: Catalog): EventDetail {
  const name = entry.name;
  const declaration: EventDeclaration | undefined = catalog.sources.find((source) => source.source === entry.source)?.events.find((event) => event.name === name);
  return {
    entry,
    ...(declaration?.schema !== undefined && { schema: declaration.schema }),
    ...(declaration?.example !== undefined && { example: declaration.example }),
    filterable: flatten(declaration?.schema, 'payload', 0),
    waitExample: waitExampleFor(name, declaration?.correlationKey),
  };
}

/** Everything known about one event name: the declaration with its schema and example, what to filter on, a wait command. */
export function getEventDetail(configDir: string, name: string, nowMs: number = Date.now()): EventDetail | undefined {
  const { entries, catalog } = allEntries(configDir, nowMs);
  const entry = entries.find((candidate) => candidate.name === name);
  return entry === undefined ? undefined : detailOf(entry, catalog);
}

/**
 * The listing and, for each listed event and in the same order, its detail: the catalog and the history are read once, where calling
 * {@link getEventDetail} per event would scan the history once per event.
 */
export function listEventDetails(configDir: string, options: ListEventsOptions = {}): { listing: EventListing; details: EventDetail[] } {
  const { entries, catalog } = allEntries(configDir, options.nowMs ?? Date.now());
  const filtered = applyFilters(entries, options);
  return { listing: listingOf(filtered, catalog), details: filtered.map((entry) => detailOf(entry, catalog)) };
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to three of `candidates` that look like `name`: a typo, the wrong case, or the beginning of a longer name. */
export function nearestEventNames(name: string, candidates: string[]): string[] {
  const wanted = name.toLowerCase();
  const threshold = Math.max(2, Math.ceil(wanted.length * 0.3));
  return candidates
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      return { candidate, prefix: wanted.length >= 3 && (lower.startsWith(wanted) || wanted.startsWith(lower)), distance: distance(wanted, lower) };
    })
    .filter((scored) => scored.prefix || scored.distance <= threshold)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((scored) => scored.candidate);
}
