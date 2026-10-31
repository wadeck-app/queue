import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getErrorMessage } from '../errors.js';
import { isRecord } from '../isRecord.js';

// The event catalog: what each program that pushes events declares about them (name, description, JSON Schema of the payload...).
// The daemon validates and stores a declaration (one file per source, <configDir>/events/<source>.json); the dashboard and the
// CLI read the files directly, like the WAL and the history. A declaration is documentation: nothing here checks a pushed payload.

export const MAX_EVENTS_PER_SOURCE = 500;
const MAX_SOURCE_LENGTH = 64;
export const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_EXAMPLE_BYTES = 16 * 1024;

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const NAME_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const PAYLOAD_PATH_PATTERN = /^payload(\.[A-Za-z0-9_-]+)+$/;

export const EVENT_OUTCOMES = ['success', 'failure', 'info'] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

export interface EventDeclaration {
  name: string;
  description: string;
  /** JSON Schema of the payload, stored as given and never interpreted. */
  schema?: Record<string, unknown>;
  /** A typical payload; prefills the "push a test event" form. */
  example?: unknown;
  /** Dotted payload paths that identify the entity the event is about (`payload.jobId`): what `queue wait --when` filters on. */
  correlationKey?: string[];
  /** This event ends the thing it is about (a job completed, failed...). */
  terminal?: boolean;
  outcome?: EventOutcome;
}

export interface SourceDeclaration {
  source: string;
  events: EventDeclaration[];
}

export interface CatalogProblem {
  /** Where, in the declaration: `source`, `events[3].name`... */
  path: string;
  message: string;
}

export type Validation = { ok: true; declaration: SourceDeclaration } | { ok: false; problems: CatalogProblem[] };

function jsonBytes(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : Buffer.byteLength(text, 'utf8');
  } catch {
    return undefined;
  }
}

function validateEvent(raw: unknown, index: number, seen: Set<string>, problems: CatalogProblem[]): EventDeclaration | undefined {
  const at = (field: string): string => `events[${index}].${field}`;
  if (!isRecord(raw)) {
    problems.push({ path: `events[${index}]`, message: 'an event must be an object { name, description }' });
    return undefined;
  }
  const before = problems.length;
  const event: Partial<EventDeclaration> = {};

  if (typeof raw['name'] !== 'string' || raw['name'] === '') {
    problems.push({ path: at('name'), message: 'name is required' });
  } else if (raw['name'].length > MAX_NAME_LENGTH || !NAME_PATTERN.test(raw['name'])) {
    problems.push({ path: at('name'), message: `name must be dot-separated segments of letters, digits, "_" or "-" (at most ${MAX_NAME_LENGTH} characters), got ${JSON.stringify(raw['name'])}` });
  } else if (seen.has(raw['name'])) {
    problems.push({ path: at('name'), message: `${raw['name']} is already declared by this source` });
  } else {
    seen.add(raw['name']);
    event.name = raw['name'];
  }

  if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
    problems.push({ path: at('description'), message: 'description is required: say when the event fires' });
  } else if (raw['description'].length > MAX_DESCRIPTION_LENGTH) {
    problems.push({ path: at('description'), message: `description is at most ${MAX_DESCRIPTION_LENGTH} characters, got ${raw['description'].length}` });
  } else {
    event.description = raw['description'];
  }

  if (raw['schema'] !== undefined) {
    const bytes = jsonBytes(raw['schema']);
    if (!isRecord(raw['schema']) || bytes === undefined) {
      problems.push({ path: at('schema'), message: 'schema must be a JSON Schema object' });
    } else if (bytes > MAX_SCHEMA_BYTES) {
      problems.push({ path: at('schema'), message: `schema is at most 64 KB, got ${Math.ceil(bytes / 1024)} KB` });
    } else {
      event.schema = raw['schema'];
    }
  }

  if (raw['example'] !== undefined) {
    const bytes = jsonBytes(raw['example']);
    if (bytes === undefined) {
      problems.push({ path: at('example'), message: 'example must be JSON' });
    } else if (bytes > MAX_EXAMPLE_BYTES) {
      problems.push({ path: at('example'), message: `example is at most 16 KB, got ${Math.ceil(bytes / 1024)} KB` });
    } else {
      event.example = raw['example'];
    }
  }

  if (raw['correlationKey'] !== undefined) {
    const keys = Array.isArray(raw['correlationKey']) ? raw['correlationKey'] : [raw['correlationKey']];
    if (keys.length === 0 || !keys.every((key) => typeof key === 'string' && PAYLOAD_PATH_PATTERN.test(key))) {
      problems.push({ path: at('correlationKey'), message: 'correlationKey must be a dotted payload path such as "payload.jobId", or a list of them' });
    } else {
      event.correlationKey = keys as string[];
    }
  }

  if (raw['terminal'] !== undefined) {
    if (typeof raw['terminal'] === 'boolean') {
      event.terminal = raw['terminal'];
    } else {
      problems.push({ path: at('terminal'), message: 'terminal must be a boolean' });
    }
  }

  if (raw['outcome'] !== undefined) {
    if (typeof raw['outcome'] === 'string' && (EVENT_OUTCOMES as readonly string[]).includes(raw['outcome'])) {
      event.outcome = raw['outcome'] as EventOutcome;
    } else {
      problems.push({ path: at('outcome'), message: `outcome must be ${EVENT_OUTCOMES.slice(0, -1).join(', ')} or ${EVENT_OUTCOMES[EVENT_OUTCOMES.length - 1]}, got ${JSON.stringify(raw['outcome'])}` });
    }
  }

  return problems.length === before ? (event as EventDeclaration) : undefined;
}

/** Checks a declaration received from a program. Every problem is reported at once, each with its path. Unknown fields are ignored (a newer SDK may add some). */
export function validateSourceDeclaration(input: unknown): Validation {
  if (!isRecord(input)) {
    return { ok: false, problems: [{ path: '', message: 'the declaration must be an object { source, events }' }] };
  }
  const problems: CatalogProblem[] = [];
  const source = input['source'];
  if (typeof source !== 'string' || source === '') {
    problems.push({ path: 'source', message: 'source is required' });
  } else if (source.length > MAX_SOURCE_LENGTH || !SOURCE_PATTERN.test(source)) {
    problems.push({ path: 'source', message: `source must be lower case letters, digits, "_" or "-", at most ${MAX_SOURCE_LENGTH} characters, got ${JSON.stringify(source)}` });
  }

  const events: EventDeclaration[] = [];
  if (!Array.isArray(input['events'])) {
    problems.push({ path: 'events', message: 'events must be a list' });
  } else if (input['events'].length > MAX_EVENTS_PER_SOURCE) {
    problems.push({ path: 'events', message: `a source declares at most ${MAX_EVENTS_PER_SOURCE} events, got ${input['events'].length}` });
  } else {
    const seen = new Set<string>();
    input['events'].forEach((raw, index) => {
      const event = validateEvent(raw, index, seen, problems);
      if (event !== undefined) {
        events.push(event);
      }
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, declaration: { source: source as string, events } };
}

export interface StoredSource extends SourceDeclaration {
  /** ISO time of the last registration. */
  registeredAt: string;
}

export interface Catalog {
  sources: StoredSource[];
  /** Files of the store that could not be read: reported, never hidden. */
  problems: Array<{ file: string; message: string }>;
}

function eventsDir(configDir: string): string {
  return join(configDir, 'events');
}

/**
 * Stores a validated declaration, replacing everything the same source declared before. The file is written to a temporary name
 * then renamed, so a reader never sees a half-written declaration.
 */
export function writeSourceDeclaration(configDir: string, declaration: SourceDeclaration, now: Date = new Date()): void {
  const dir = eventsDir(configDir);
  mkdirSync(dir, { recursive: true });
  const stored: StoredSource = { source: declaration.source, registeredAt: now.toISOString(), events: declaration.events };
  const target = join(dir, `${declaration.source}.json`);
  const temporary = join(dir, `.${declaration.source}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  renameSync(temporary, target);
}

/** Every declared source, sorted by name. A file that cannot be read goes to `problems`. */
export function readCatalog(configDir: string): Catalog {
  const dir = eventsDir(configDir);
  if (!existsSync(dir)) {
    return { sources: [], problems: [] };
  }
  const sources: StoredSource[] = [];
  const problems: Catalog['problems'] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      problems.push({ file, message: `not valid JSON (${getErrorMessage(error)}): delete it, the program that owns it declares its events again at its next start` });
      continue;
    }
    const checked = validateSourceDeclaration(parsed);
    if (!checked.ok || !isRecord(parsed) || typeof parsed['registeredAt'] !== 'string') {
      problems.push({ file, message: checked.ok ? 'registeredAt is missing' : checked.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ') });
      continue;
    }
    sources.push({ ...checked.declaration, registeredAt: parsed['registeredAt'] });
  }
  return { sources, problems };
}
