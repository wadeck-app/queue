import { eventPatternProblem } from '../dispatch/EventMatcher.js';
import { waiterFileName, waiterNameProblem } from './waiterName.js';

/** The version of the waiter file format (a local file contract, not a wire one). A reader ignores a record of another version and says so. */
export const WAITER_RECORD_VERSION = 1;

export const WAITER_LIMITS = {
  /** A record file is at most this big; a bigger one is not read. */
  maxFileBytes: 16 * 1024,
  maxEvents: 20,
  maxWhens: 20,
  /** One event pattern or one `--when` expression. */
  maxTextChars: 500,
  maxLabelChars: 200,
  /** The path of a pipe contact (a Windows pipe name is 256 characters at most). */
  maxContactPathChars: 300,
} as const;

/**
 * How the daemon can wake the waiter. `pipe`: the wait listens on a named pipe (Windows) or a unix socket (POSIX) at `path`. `none`: it only polls the history.
 * The path is what the wait says it listens on; the daemon never connects to it as written, it recomputes the address from the name (see WaiterWake.ts) and compares.
 */
export type WaiterContact = { kind: 'none' } | { kind: 'pipe'; path: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function contactProblem(contact: WaiterContact): string | undefined {
  if (contact.kind === 'none') {
    return undefined;
  }
  if (typeof contact.path !== 'string' || contact.path === '' || contact.path.length > WAITER_LIMITS.maxContactPathChars || CONTROL.test(contact.path)) {
    return 'a pipe contact needs a path of 1 to ' + WAITER_LIMITS.maxContactPathChars + ' printable characters';
  }
  return undefined;
}

/** The contact in a record, or undefined when it is not one. */
export function parseWaiterContact(value: unknown): WaiterContact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['kind'] === 'none') {
    return { kind: 'none' };
  }
  if (value['kind'] === 'pipe') {
    const contact: WaiterContact = { kind: 'pipe', path: value['path'] as string };
    return contactProblem(contact) === undefined ? contact : undefined;
  }
  return undefined;
}

/**
 * One waiting `queue wait`, as the file `waiters/waiter-<name>.json` and the `start` record of the waits history hold it.
 * Counting rule: the waiter counts for an event when one of `events` matches its name and EVERY filter of `whens` holds on the event as the history holds it.
 * A wait with several events that have different filters registers no filter (`whens: []`): it counts for more pushes than needed, never fewer.
 * No payload is ever stored.
 */
export interface WaiterRecord {
  v: typeof WAITER_RECORD_VERSION;
  /** Random per registration: takes part in every ownership check, so a pid or a name that is reused is never mistaken for the owner. */
  id: string;
  name: string;
  /** Event names or patterns (`EventMatcher`). */
  events: string[];
  /** `when:` expressions, same syntax as the subscribers'. */
  whens: string[];
  /** Free text shown in lists (the sha for `wait ci`). */
  label: string;
  contact: WaiterContact;
  pid: number;
  cwd: string;
  /** ISO: the effective `--since` of the wait (shown, never used by the daemon). */
  since: string;
  /** ISO: when the wait registered. */
  startedAt: string;
}

export type ParsedWaiterRecord =
  | { ok: true; record: WaiterRecord }
  | { ok: false; kind: 'malformed' | 'unknown-version' | 'oversize'; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function stringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && item.length <= WAITER_LIMITS.maxTextChars);
}

/**
 * Reads the text of a waiter file. Never throws: a file that cannot be used is described by `problem` (it names the file), and is ignored by the reader, never counted.
 * `fileName` is the base name; the name in the record must be the one in it.
 */
export function parseWaiterRecord(text: string, fileName: string): ParsedWaiterRecord {
  if (text.length > WAITER_LIMITS.maxFileBytes) {
    return { ok: false, kind: 'oversize', problem: `${fileName} is over ${WAITER_LIMITS.maxFileBytes} bytes: it was not read` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, kind: 'malformed', problem: `${fileName} is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(value)) {
    return { ok: false, kind: 'malformed', problem: `${fileName} does not hold a JSON object` };
  }
  if (value['v'] !== WAITER_RECORD_VERSION) {
    return { ok: false, kind: 'unknown-version', problem: `${fileName} has format version ${JSON.stringify(value['v'])}, this queue reads version ${WAITER_RECORD_VERSION}: a different queue release wrote it, update queue-cli (queue cli update)` };
  }
  const bad = (what: string) => ({ ok: false as const, kind: 'malformed' as const, problem: `${fileName} has an invalid ${what}` });
  const { id, name, events, whens, label, contact, pid, cwd, since, startedAt } = value;
  if (typeof id !== 'string' || id === '') return bad('id');
  if (typeof name !== 'string' || waiterNameProblem(name) !== undefined) return bad('name');
  if (waiterFileName(name) !== fileName) return { ok: false, kind: 'malformed', problem: `${fileName} holds the name '${name}', which is not the name in the file name` };
  if (!stringList(events, WAITER_LIMITS.maxEvents) || events.length === 0) return bad('events list');
  if (!stringList(whens, WAITER_LIMITS.maxWhens)) return bad('whens list');
  if (typeof label !== 'string' || label.length > WAITER_LIMITS.maxLabelChars) return bad('label');
  const parsedContact = parseWaiterContact(contact);
  if (parsedContact === undefined) return bad('contact');
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return bad('pid');
  if (typeof cwd !== 'string') return bad('cwd');
  if (!isIsoDate(since)) return bad('since');
  if (!isIsoDate(startedAt)) return bad('startedAt');
  return { ok: true, record: { v: WAITER_RECORD_VERSION, id, name, events, whens, label, contact: parsedContact, pid, cwd, since, startedAt } };
}

export interface WaiterInput {
  name: string;
  events: string[];
  whens: string[];
  label: string;
  since: string;
  cwd: string;
  /** The pipe the wait listens on. Default: none (it polls only). */
  contact?: WaiterContact;
}

/** Why a registration is refused (what to fix included), undefined when the input can be registered. */
export function validateWaiterInput(input: WaiterInput): string | undefined {
  const nameProblem = waiterNameProblem(input.name);
  if (nameProblem !== undefined) {
    return nameProblem;
  }
  if (input.events.length === 0) {
    return 'a waiter needs at least one event to wait for.';
  }
  if (input.events.length > WAITER_LIMITS.maxEvents) {
    return `a waiter can wait for ${WAITER_LIMITS.maxEvents} events at most, got ${input.events.length}.`;
  }
  for (const event of input.events) {
    const problem = eventPatternProblem(event);
    if (problem !== null) {
      return `event ${problem}`;
    }
    if (event.length > WAITER_LIMITS.maxTextChars) {
      return `an event name is over ${WAITER_LIMITS.maxTextChars} characters.`;
    }
  }
  if (input.whens.length > WAITER_LIMITS.maxWhens) {
    return `a waiter can have ${WAITER_LIMITS.maxWhens} --when filters at most, got ${input.whens.length}.`;
  }
  if (input.whens.some((when) => when.length > WAITER_LIMITS.maxTextChars)) {
    return `a --when filter is over ${WAITER_LIMITS.maxTextChars} characters.`;
  }
  if (input.label.length > WAITER_LIMITS.maxLabelChars) {
    return `the label is over ${WAITER_LIMITS.maxLabelChars} characters.`;
  }
  const contact = input.contact === undefined ? undefined : contactProblem(input.contact);
  if (contact !== undefined) {
    return `the contact is not valid: ${contact}.`;
  }
  return undefined;
}
