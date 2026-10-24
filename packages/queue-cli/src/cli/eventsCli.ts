/**
 * `queue events list|show|register`: the event catalog (what each program declared, joined with the history). Pure and injectable:
 * the config dir, the clock, file reading and the daemon call come from `EventsDeps`, so nothing here starts a process or sleeps.
 */

import {
  getErrorMessage,
  getEventDetail,
  listEvents,
  nearestEventNames,
  type CatalogEntry,
  type EventDetail,
  type RegisterEventsRequest,
  type RegisterEventsResponse,
} from '@wadeck-app/queue-core';

export const EVENTS_EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 4,
} as const;

export const EVENTS_HELP = `queue events - The catalog of events: what each program declares it pushes, and what really happened
Usage:
  queue events list [--source <name>] [--prefix <text>] [--match <pattern>] [--declared-only] [--terminal] [--json]
  queue events show <name> [--json]
  queue events register --source <name> --file <events.json> [--json]

queue events list: the declared events plus the names seen in the last 7 days that nobody declared ("(undeclared)").
  --source <name>    Only the events declared by that program
  --prefix <text>    Only the names that start with the text (job.)
  --match <pattern>  Only the names matching a subscribers.yml pattern ("flow.>", "job.*")
  --declared-only    Hide the names only seen in the history
  --terminal         Only the events that end the thing they are about (completed, failed...)
  --json             { "events": [...], "total": N, "sources": [...], "problems": [...] } without the schemas
  "24H" counts the pushes of the last 24 hours. "not in 7d" means no push in the last 7 days (not necessarily never).

queue events show <name>: description, source, outcome, correlation key, schema, example, the payload paths to filter on with
  "queue wait --when", and a ready "queue wait" command. An unknown name exits 4 with the nearest names.

queue events register: for programs that do not use the Node SDK. The file holds { "events": [...] } or the bare array; each
  event is { "name", "description", "schema"?, "example"?, "correlationKey"?, "terminal"?, "outcome"? }. It replaces everything
  that source declared before. The daemon is started if needed.

Exit codes: 0 ok | 1 failed (rejected declaration, unreadable file, old daemon) | 4 invalid usage / unknown event
`;

export interface EventsIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/** What the daemon answered: its response, or "unknown command" (an older daemon, HTTP 404). */
export type RegisterResult = { kind: 'response'; response: RegisterEventsResponse } | { kind: 'unsupported' };

export interface EventsDeps {
  configDir: string;
  io: EventsIO;
  now: () => number;
  readFile: (path: string) => string;
  register: (request: RegisterEventsRequest) => Promise<RegisterResult>;
  /** The SDK protocol version sent with a declaration. */
  protocolVersion: string;
}

interface ParsedFlags {
  values: Map<string, string>;
  switches: Set<string>;
  positionals: string[];
  errors: string[];
}

function parseFlags(args: string[], valueFlags: string[], switchFlags: string[], io: EventsIO): ParsedFlags {
  const parsed: ParsedFlags = { values: new Map(), switches: new Set(), positionals: [], errors: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valueFlags.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        parsed.errors.push(`${arg} needs a value.`);
      } else {
        parsed.values.set(arg, value);
        i++;
      }
    } else if (switchFlags.includes(arg)) {
      parsed.switches.add(arg);
    } else if (arg.startsWith('-')) {
      io.stderr.write(`[warn] queue events: unknown argument '${arg}' -- ignored\n`);
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

function usageError(io: EventsIO, message: string): number {
  io.stderr.write(`[fail] ${message}\n`);
  return EVENTS_EXIT.USAGE;
}

function ago(isoTime: string | null, nowMs: number): string {
  if (isoTime === null) {
    return 'not in 7d';
  }
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(isoTime)) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === 2 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join('  ').trimEnd());
}

function warnProblems(problems: Array<{ file: string; message: string }>, io: EventsIO): void {
  for (const problem of problems) {
    io.stderr.write(`[warn] events/${problem.file}: ${problem.message}\n`);
  }
}

function list(args: string[], deps: EventsDeps): number {
  const { io } = deps;
  const flags = parseFlags(args, ['--source', '--prefix', '--match'], ['--declared-only', '--terminal', '--json'], io);
  if (flags.errors.length > 0) {
    return usageError(io, flags.errors.join(' '));
  }
  for (const stray of flags.positionals) {
    io.stderr.write(`[warn] queue events list: unexpected argument '${stray}' -- ignored\n`);
  }
  const source = flags.values.get('--source');
  const prefix = flags.values.get('--prefix');
  const match = flags.values.get('--match');
  const listing = listEvents(deps.configDir, {
    nowMs: deps.now(),
    ...(source !== undefined && { source }),
    ...(prefix !== undefined && { prefix }),
    ...(match !== undefined && { match }),
    ...(flags.switches.has('--declared-only') && { declaredOnly: true }),
    ...(flags.switches.has('--terminal') && { terminal: true }),
  });
  warnProblems(listing.problems, io);

  if (flags.switches.has('--json')) {
    io.stdout.write(JSON.stringify({ events: listing.events, total: listing.total, sources: listing.sources, problems: listing.problems }) + '\n');
    return EVENTS_EXIT.OK;
  }
  if (listing.events.length === 0) {
    io.stdout.write('No events match. A program declares its events with the SDK or "queue events register" (see "queue events --help").\n');
    return EVENTS_EXIT.OK;
  }
  const rows = [['NAME', 'SOURCE', '24H', 'LAST SEEN', '']];
  for (const event of listing.events) {
    rows.push([event.name, event.source ?? '-', String(event.count24h), ago(event.lastSeenAt, deps.now()), event.declared ? '' : '(undeclared)']);
  }
  io.stdout.write(table(rows).join('\n') + '\n');
  io.stdout.write(`${listing.total} event${listing.total === 1 ? '' : 's'}, ${listing.sources.length} source${listing.sources.length === 1 ? '' : 's'}\n`);
  return EVENTS_EXIT.OK;
}

function describeEntry(entry: CatalogEntry, nowMs: number): string[] {
  const lines = [entry.name];
  if (!entry.declared) {
    lines.push('', 'This name was seen in the history but is not declared by any program.');
  } else {
    lines.push('', entry.description ?? '');
  }
  const field = (label: string, value: string): string => `${`${label}:`.padEnd(14)}${value}`;
  lines.push('', field('source', entry.source ?? '-'));
  if (entry.declared) {
    lines.push(field('terminal', entry.terminal === true ? `yes${entry.outcome === undefined ? '' : ` (${entry.outcome})`}` : 'no'));
    lines.push(field('correlation', entry.correlationKey === undefined ? '-' : entry.correlationKey.join(', ')));
  }
  lines.push(field('last 24h', String(entry.count24h)), field('last seen', ago(entry.lastSeenAt, nowMs)));
  return lines;
}

function describeDetail(detail: EventDetail, nowMs: number): string {
  const lines = describeEntry(detail.entry, nowMs);
  if (detail.schema !== undefined) {
    lines.push('', 'schema:', JSON.stringify(detail.schema, null, 2));
  }
  if (detail.example !== undefined) {
    lines.push('', 'example:', JSON.stringify(detail.example, null, 2));
  }
  if (detail.filterable.length > 0) {
    lines.push('', 'filter with "queue wait --when payload.path=value":');
    const rows = detail.filterable.map((item) => [item.path, item.type, item.required ? 'required' : 'optional']);
    const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
    for (const row of rows) {
      lines.push(`  ${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!}`);
    }
  }
  lines.push('', 'wait for it:', `  ${detail.waitExample}`);
  return lines.join('\n') + '\n';
}

function show(args: string[], deps: EventsDeps): number {
  const { io } = deps;
  const flags = parseFlags(args, [], ['--json'], io);
  const name = flags.positionals[0];
  if (name === undefined) {
    return usageError(io, 'No event name given. Usage: queue events show <name> [--json] ("queue events list" shows the names).');
  }
  const detail = getEventDetail(deps.configDir, name, deps.now());
  const json = flags.switches.has('--json');
  if (detail === undefined) {
    const suggestions = nearestEventNames(name, listEvents(deps.configDir, { nowMs: deps.now() }).events.map((event) => event.name));
    if (json) {
      io.stdout.write(JSON.stringify({ found: false, suggestions }) + '\n');
    }
    io.stderr.write(
      suggestions.length > 0
        ? `[fail] No event named "${name}"; did you mean: ${suggestions.join(', ')}\n`
        : `[fail] No event named "${name}", declared or seen in the last 7 days. "queue events list" shows the names.\n`,
    );
    return EVENTS_EXIT.USAGE;
  }
  io.stdout.write(json ? JSON.stringify(detail) + '\n' : describeDetail(detail, deps.now()));
  return EVENTS_EXIT.OK;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

async function register(args: string[], deps: EventsDeps): Promise<number> {
  const { io } = deps;
  const flags = parseFlags(args, ['--source', '--file'], ['--json'], io);
  if (flags.errors.length > 0) {
    return usageError(io, flags.errors.join(' '));
  }
  const source = flags.values.get('--source');
  const file = flags.values.get('--file');
  if (source === undefined || file === undefined) {
    return usageError(io, `${source === undefined ? '--source <name>' : '--file <events.json>'} is required. Usage: queue events register --source <name> --file <events.json> [--json]`);
  }
  const json = flags.switches.has('--json');
  const fail = (message: string): number => {
    io.stderr.write(`[fail] ${message}\n`);
    return EVENTS_EXIT.FAILED;
  };

  let content: string;
  try {
    content = deps.readFile(file);
  } catch (error) {
    return fail(`Cannot read ${file}: ${getErrorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return fail(`${file} is not valid JSON (${getErrorMessage(error)}).`);
  }
  const events = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) {
    return fail(`${file} must hold { "events": [...] } or the bare array of events, with a "events" array.`);
  }

  const result = await deps.register({ protocol: deps.protocolVersion, source, events });
  if (result.kind === 'unsupported') {
    return fail('This daemon does not know "register-events" (it is older than the event catalog): update queue-cli ("queue cli update"), then restart the daemon ("queue stop"; the next command starts the new one).');
  }
  const { response } = result;
  if (response.status === 'registered') {
    const count = response.count ?? events.length;
    io.stdout.write(json ? JSON.stringify({ registered: true, source: response.source ?? source, count }) + '\n' : `registered ${plural(count, 'event')} for ${response.source ?? source}\n`);
    return EVENTS_EXIT.OK;
  }
  if (json) {
    io.stdout.write(JSON.stringify({ registered: false, reason: response.reason, ...(response.problems !== undefined && { problems: response.problems }), ...(response.supported !== undefined && { supported: response.supported }) }) + '\n');
  }
  if (response.problems !== undefined && response.problems.length > 0) {
    io.stderr.write(`[fail] The daemon rejected the declaration of ${source}:\n`);
    for (const problem of response.problems) {
      io.stderr.write(`  ${problem.path === '' ? 'declaration' : problem.path}: ${problem.message}\n`);
    }
  } else {
    io.stderr.write(`[fail] The daemon rejected the declaration of ${source}: ${response.reason ?? 'no reason given'}${response.supported === undefined ? '' : ` (it supports protocol ${response.supported}: update queue-cli or the daemon)`}\n`);
  }
  return EVENTS_EXIT.FAILED;
}

/** `args` is everything after `queue events`. Returns the exit code. */
export async function eventsCommand(args: string[], deps: EventsDeps): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h') {
    deps.io.stdout.write(EVENTS_HELP);
    return EVENTS_EXIT.OK;
  }
  if (sub === undefined) {
    deps.io.stdout.write(EVENTS_HELP);
    return EVENTS_EXIT.USAGE;
  }
  const rest = args.slice(1);
  if (sub === 'list') {
    return list(rest, deps);
  }
  if (sub === 'show') {
    return show(rest, deps);
  }
  if (sub === 'register') {
    return register(rest, deps);
  }
  return usageError(deps.io, `Unknown subcommand "${sub}". Valid: list, show, register ("queue events --help").`);
}
