import { SUBSCRIBER_NAME_FORMAT, findTemplateProblem, isValidSubscriberName } from '@wadeck-app/queue-core';
import { isMissingValue, nearestFlag, scanFlags } from './flagScan.js';
import type { SubscriberConfig } from '@wadeck-app/queue-core';

const FORBIDDEN_KEY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Applies one `--set key=value` to `target`; returns the problem (what is wrong and what to write), undefined when it was applied. */
function setSetting(target: Record<string, unknown>, text: string): string | undefined {
  const eq = text.indexOf('=');
  if (eq === -1) {
    return `Invalid --set "${text}": expected key=value, e.g. --set to=project:my-app`;
  }
  const key = text.slice(0, eq).trim();
  const value = text.slice(eq + 1);
  const segments = key.split('.');
  if (key === '' || segments.some((segment) => segment === '')) {
    return `Invalid --set "${text}": the key is empty or has an empty part (write e.g. payload.text=hello)`;
  }
  const forbidden = segments.find((segment) => FORBIDDEN_KEY_SEGMENTS.has(segment));
  if (forbidden !== undefined) {
    return `Invalid --set "${text}": the key part '${forbidden}' is not allowed`;
  }
  let level = target;
  for (const segment of segments.slice(0, -1)) {
    // Own keys only: a key named like a member of Object.prototype (toString) is not 'already set'
    const next = Object.hasOwn(level, segment) ? level[segment] : undefined;
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      level[segment] = created;
      level = created;
    } else if (typeof next === 'object' && next !== null) {
      level = next as Record<string, unknown>;
    } else {
      return `Invalid --set "${text}": '${segment}' is already set to a plain value, it cannot also hold nested keys. Fix: set either '${segment}' or '${segment}.<key>'`;
    }
  }
  const last = segments[segments.length - 1]!;
  if (Object.hasOwn(level, last)) {
    return `Invalid --set "${text}": '${key}' is set twice. Fix: pass each key once`;
  }
  level[last] = value;
  return undefined;
}

/** The sub-commands that write a subscribers.yml. */
export type SubCommand = 'add' | 'edit' | 'remove';

const SUB_VALUE_FLAGS = ['--name', '--type', '--action', '--set', '--command', '--url', '--method', '--header', '--timeout', '--retries', '--backoff', '--when', '--unset', '--index', '--scope'] as const;
const SUB_SWITCHES = ['--rewrite'] as const;
const SUB_REPEATABLE = ['--set', '--header', '--unset'] as const;
/** The flags each sub-command takes; with no command named, every flag is accepted. */
const FLAGS_OF: Record<SubCommand, ReadonlySet<string>> = {
  add: new Set<string>([...SUB_VALUE_FLAGS.filter((flag) => flag !== '--index' && flag !== '--unset'), ...SUB_SWITCHES]),
  edit: new Set<string>([...SUB_VALUE_FLAGS, ...SUB_SWITCHES]),
  remove: new Set(['--name', '--index', '--scope', '--rewrite']),
};

const SUB_NEEDS: Readonly<Record<string, string>> = {
  '--name': 'a value, e.g. --name notify',
  '--type': 'a value: cli, http or action, e.g. --type cli',
  '--action': 'the name of the action, e.g. --action emit',
  '--set': 'a key=value, e.g. --set to=project:my-app',
  '--command': 'a value, e.g. --command "echo hi"',
  '--url': 'a value, e.g. --url https://example.test/hook',
  '--method': 'a value: POST, PUT, PATCH or DELETE, e.g. --method PUT',
  '--header': 'a key:value, e.g. --header "Authorization: Bearer abc"',
  '--timeout': 'a value, e.g. --timeout 30s (30s, 5m, 1h)',
  '--retries': 'a value, e.g. --retries 3 (a whole number, 0 or more)',
  '--backoff': 'a value: exponential or linear, e.g. --backoff linear',
  '--when': 'a value, e.g. --when payload.status=done',
  '--unset': 'a field name, e.g. --unset timeout',
  '--index': 'a value, e.g. --index 0 (a whole number, 0 or more)',
  '--scope': 'a value, e.g. --scope project (global or project)',
};

/** The verbs of an http subscriber: the event travels as a JSON body, which GET and HEAD cannot carry. */
export const HTTP_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const UNSET_FIELDS = ['timeout', 'retries', 'backoff', 'when', 'method', 'command', 'url', 'action', 'cwd', 'headers', 'env', 'with'] as const;
const UNSET_NESTED = ['headers', 'env', 'with'] as const;

/** Why `--unset <path>` is not usable, undefined when it is. */
function unsetProblem(path: string): string | undefined {
  const listed = `Fields: ${UNSET_FIELDS.join(', ')}, headers.<name>, env.<name>, with.<key>[.<key>...]`;
  if (path === 'name' || path === 'type') {
    return `--unset '${path}': '${path}' cannot be removed, every subscriber has a name and a type (change them with --${path})`;
  }
  const segments = path.split('.');
  const head = segments[0]!;
  if (segments.length === 1) {
    if ((UNSET_FIELDS as readonly string[]).includes(head)) {
      return undefined;
    }
    const near = nearestFlag(head, UNSET_FIELDS);
    return `--unset '${path}' is not a field that can be removed${near === undefined ? '' : ` (did you mean '${near}'?)`}. ${listed}`;
  }
  if (!(UNSET_NESTED as readonly string[]).includes(head)) {
    return (UNSET_FIELDS as readonly string[]).includes(head)
      ? `--unset '${path}': '${head}' has no sub-keys, write --unset ${head}. ${listed}`
      : `--unset '${path}' is not a field that can be removed. ${listed}`;
  }
  if (segments.some((segment) => segment === '')) {
    return `--unset '${path}': the key has an empty part (write e.g. ${head}.<name>)`;
  }
  const forbidden = segments.find((segment) => FORBIDDEN_KEY_SEGMENTS.has(segment));
  return forbidden === undefined ? undefined : `--unset '${path}': the key part '${forbidden}' is not allowed`;
}

export interface SubFlags {
  config: Partial<SubscriberConfig>;
  errors: string[];
  /** The fields to remove (`--unset`), validated. */
  unset: string[];
  /** `--rewrite`: the user accepts that rewriting the file drops its comments. */
  rewrite: boolean;
  /** Every flag that was given. */
  given: Set<string>;
}

/**
 * Reads the flags of `queue sub add|edit|remove` (everything after the event). Nothing is dropped silently: a flag without its value, an
 * invalid number or verb, an unknown option and a stray word are all errors that say what to write. `command` limits the flags to those
 * the sub-command takes; without it every flag is accepted.
 */
export function parseSubFlags(args: string[], command?: SubCommand): SubFlags {
  const allowed = command === undefined ? undefined : FLAGS_OF[command];
  const takes = (flag: string): boolean => allowed === undefined || allowed.has(flag);
  const scan = scanFlags(
    args,
    {
      values: SUB_VALUE_FLAGS.filter(takes),
      repeatable: SUB_REPEATABLE,
      switches: SUB_SWITCHES.filter(takes),
      needs: SUB_NEEDS,
    },
    command === undefined ? 'queue sub' : `queue sub ${command}`,
    [...SUB_VALUE_FLAGS, ...SUB_SWITCHES].filter((flag) => !takes(flag)),
  );
  const errors: string[] = scan.issues.map((issue) => issue.message);
  const config: Partial<SubscriberConfig> = {};
  const given = new Set<string>([...scan.values.keys(), ...scan.switches]);
  const first = (flag: string): string | undefined => scan.values.get(flag)?.[0];

  const nameVal = first('--name');
  if (nameVal !== undefined) {
    if (!isValidSubscriberName(nameVal)) {
      errors.push(`--name ${JSON.stringify(nameVal)} is not valid: use ${SUBSCRIBER_NAME_FORMAT} (lowercase letters, digits, '.', '_', '-'; at most 64 characters)`);
    } else {
      config.name = nameVal;
    }
  }

  const typeVal = first('--type');
  if (typeVal === 'cli' || typeVal === 'http' || typeVal === 'action') {
    config.type = typeVal;
  } else if (typeVal !== undefined) {
    errors.push(`--type must be cli, http or action, got: ${typeVal}`);
  }

  const actionVal = first('--action');
  if (actionVal !== undefined) {
    config.action = actionVal;
  }

  // Repeatable, like --header: --set key=value, split on the first '='. A dotted key (payload.text) nests, so the payload of 'emit' can be written
  const settings: Record<string, unknown> = {};
  for (const val of scan.values.get('--set') ?? []) {
    const problem = setSetting(settings, val);
    if (problem !== undefined) {
      errors.push(problem);
    }
  }
  if (Object.keys(settings).length > 0) {
    config.with = settings;
  }

  // Said here, not dropped: these flags mean nothing for the other type
  if (config.type === 'action') {
    for (const flag of ['--command', '--url', '--method', '--header']) {
      if (given.has(flag)) {
        errors.push(`${flag} does not apply to --type action (an action runs inside the daemon and takes its settings from --set). Fix: remove ${flag}, or use --type ${flag === '--command' ? 'cli' : 'http'}`);
      }
    }
  } else if (config.type !== undefined && (given.has('--action') || given.has('--set'))) {
    errors.push(`--action and --set only apply to --type action, got --type ${config.type}. Fix: use --type action, or remove them`);
  }

  const commandVal = first('--command');
  if (commandVal !== undefined) {
    config.command = commandVal;
  }

  const urlVal = first('--url');
  if (urlVal !== undefined) {
    config.url = urlVal;
  }

  const methodVal = first('--method');
  if (methodVal !== undefined) {
    const verb = methodVal.toUpperCase();
    if ((HTTP_METHODS as readonly string[]).includes(verb)) {
      config.method = verb;
    } else if (verb === 'GET' || verb === 'HEAD') {
      errors.push(`--method ${methodVal} is not accepted: the event is sent as a JSON body, which ${verb} cannot carry. Use ${HTTP_METHODS.join(', ')}`);
    } else {
      errors.push(`--method must be one of ${HTTP_METHODS.join(', ')}, got: ${methodVal}`);
    }
  }

  const headers: Record<string, string> = {};
  for (const val of scan.values.get('--header') ?? []) {
    const colonIdx = val.indexOf(':');
    if (colonIdx <= 0) {
      errors.push(`Invalid --header format: "${val}" (expected "key:value")`);
    } else {
      headers[val.slice(0, colonIdx).trim()] = val.slice(colonIdx + 1).trim();
    }
  }
  if (Object.keys(headers).length > 0) {
    config.headers = headers;
  }

  const timeoutVal = first('--timeout');
  if (timeoutVal !== undefined) {
    if (!/^\d+(ms|s|m|h)$/.test(timeoutVal)) {
      errors.push(`Invalid --timeout: ${JSON.stringify(timeoutVal)} (use e.g. 30s, 5m, 1h)`);
    } else {
      config.timeout = timeoutVal;
    }
  }

  const retriesVal = first('--retries');
  if (retriesVal !== undefined) {
    const n = Number(retriesVal);
    if (!/^\d+$/.test(retriesVal) || !Number.isSafeInteger(n)) {
      errors.push(`--retries must be a whole number, 0 or more (e.g. --retries 3), got: ${retriesVal}`);
    } else {
      config.retries = n;
    }
  }

  const backoffVal = first('--backoff');
  if (backoffVal === 'exponential' || backoffVal === 'linear') {
    config.backoff = backoffVal;
  } else if (backoffVal !== undefined) {
    errors.push(`--backoff must be exponential or linear, got: ${backoffVal}`);
  }

  const whenVal = first('--when');
  if (whenVal !== undefined) {
    config.when = whenVal;
  }

  const indexVal = first('--index');
  if (indexVal !== undefined && !/^\d+$/.test(indexVal)) {
    errors.push(`--index must be a non-negative integer, got: ${indexVal}`);
  }

  const unset: string[] = [];
  for (const path of scan.values.get('--unset') ?? []) {
    const problem = unsetProblem(path);
    if (problem === undefined) {
      unset.push(path);
    } else {
      errors.push(problem);
    }
  }

  // Empty values never reach here: scanFlags reports them as missing
  return { config, errors, unset, rewrite: scan.switches.has('--rewrite'), given };
}

/** The `--scope` flag of any `queue sub` command: global when absent; a missing or unknown value is an error, never a silent fallback. */
export function parseScopeFlag(args: readonly string[]): { scope: 'global' | 'project'; given: boolean } | { error: string } {
  const at = args.indexOf('--scope');
  if (at === -1) {
    return { scope: 'global', given: false };
  }
  const value = args[at + 1];
  if (isMissingValue(value)) {
    return { error: `--scope needs ${SUB_NEEDS['--scope']}` };
  }
  if (value !== 'global' && value !== 'project') {
    return { error: `--scope must be global or project, got: ${value}` };
  }
  return { scope: value, given: true };
}

/** The fields that belong to one type only; `cwd` and `env` are shared by cli and http (an action refuses them). */
const TYPE_FIELDS: Record<SubscriberConfig['type'], readonly string[]> = {
  cli: ['command'],
  http: ['url', 'method', 'headers'],
  action: ['action', 'with'],
};
const SHARED_CLI_HTTP_FIELDS = ['cwd', 'env'];

function fieldsOf(type: SubscriberConfig['type']): string[] {
  return [...TYPE_FIELDS[type], ...(type === 'action' ? [] : SHARED_CLI_HTTP_FIELDS)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges `source` into `target` key by key (own keys only): an object meets an object recursively, anything else replaces. */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const incoming = source[key];
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlainObject(incoming) && isPlainObject(current)) {
      mergeInto(current, incoming);
    } else {
      target[key] = incoming;
    }
  }
}

/** The paths a set of flags writes (`timeout`, `headers.X`, `with.payload.text`), to tell a contradicting --unset. */
function writtenPaths(config: Partial<SubscriberConfig>): string[] {
  const paths: string[] = [];
  for (const field of ['command', 'url', 'method', 'timeout', 'retries', 'backoff', 'when', 'action'] as const) {
    if (config[field] !== undefined) {
      paths.push(field);
    }
  }
  for (const header of Object.keys(config.headers ?? {})) {
    paths.push(`headers.${header}`);
  }
  const walk = (value: unknown, prefix: string): void => {
    if (isPlainObject(value)) {
      for (const [key, inner] of Object.entries(value)) {
        walk(inner, `${prefix}.${key}`);
      }
    } else {
      paths.push(prefix);
    }
  };
  if (config.with !== undefined) {
    walk(config.with, 'with');
  }
  return paths;
}

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

export interface MergeInput {
  config: Partial<SubscriberConfig>;
  /** `--unset` paths, already validated by parseSubFlags. */
  unset: readonly string[];
  /** The flags that were given (to refuse one that does not fit the type the entry keeps). */
  given: ReadonlySet<string>;
}

export type MergeResult = { entry: SubscriberConfig; cleared: string[]; notes: string[] } | { errors: string[] };

/**
 * The entry `queue sub edit` writes: the existing entry with the flags merged over it. What the flags do not say is kept (retries, timeout, backoff, when,
 * headers, with, cwd, env and keys this CLI does not know); `--unset` removes a field on purpose; `--header` and `--set` merge per key. Changing the type
 * clears the fields of the old type (listed in `cleared`, so the user is told), and the companions of the new type are checked by `entryProblems`.
 */
export function mergeSubscriberEntry(previous: SubscriberConfig, input: MergeInput): MergeResult {
  const { config, unset, given } = input;
  const errors: string[] = [];
  const notes: string[] = [];
  const entry = structuredClone(previous) as unknown as Record<string, unknown>;
  const toType = config.type ?? previous.type;

  // The type comes from the entry: the flags of the other type would be silently useless, so they are refused (parseSubFlags did it when --type was given)
  if (config.type === undefined) {
    if (toType === 'action') {
      for (const flag of ['--command', '--url', '--method', '--header']) {
        if (given.has(flag)) {
          errors.push(`${flag} does not apply to type action (an action runs inside the daemon and takes its settings from --set). Fix: remove ${flag}, or change the type with --type`);
        }
      }
    } else if (given.has('--action') || given.has('--set')) {
      errors.push(`--action and --set only apply to type action, and this subscriber is ${toType}. Fix: use --type action, or remove them`);
    }
  }
  const written = writtenPaths(config);
  for (const path of unset) {
    const clash = written.find((other) => overlaps(path, other));
    if (clash !== undefined) {
      errors.push(`--unset ${path} contradicts the flag that sets ${clash} in the same command: use one of them`);
    }
  }
  if (errors.length > 0) {
    return { errors };
  }

  const cleared: string[] = [];
  if (toType !== previous.type) {
    const kept = new Set(fieldsOf(toType));
    for (const field of fieldsOf(previous.type)) {
      if (!kept.has(field) && entry[field] !== undefined) {
        delete entry[field];
        cleared.push(field);
      }
    }
    entry['type'] = toType;
  }

  for (const path of unset) {
    const segments = path.split('.');
    let level: unknown = entry;
    let found = true;
    for (const segment of segments.slice(0, -1)) {
      level = isPlainObject(level) && Object.hasOwn(level, segment) ? level[segment] : undefined;
    }
    const last = segments[segments.length - 1]!;
    if (isPlainObject(level) && Object.hasOwn(level, last)) {
      delete level[last];
    } else {
      found = false;
    }
    if (!found) {
      notes.push(`--unset ${path}: the subscriber has no '${path}', nothing to remove`);
    } else if (segments.length > 1 && (segments[0] === 'headers' || segments[0] === 'env') && Object.keys(entry[segments[0]] as object).length === 0) {
      delete entry[segments[0]];
    }
  }

  for (const field of ['name', 'command', 'url', 'method', 'timeout', 'retries', 'backoff', 'when', 'action'] as const) {
    if (config[field] !== undefined) {
      entry[field] = config[field];
    }
  }
  if (config.headers !== undefined) {
    const headers = isPlainObject(entry['headers']) ? entry['headers'] : {};
    mergeInto(headers, config.headers);
    entry['headers'] = headers;
  }
  if (config.with !== undefined) {
    const settings = isPlainObject(entry['with']) ? entry['with'] : {};
    mergeInto(settings, config.with);
    entry['with'] = settings;
  }
  // An action without settings still has a (empty) with, so the plugin says what is missing
  if (toType === 'action' && entry['with'] === undefined) {
    entry['with'] = {};
  }
  return { entry: entry as unknown as SubscriberConfig, cleared, notes };
}

/**
 * What an entry still lacks to be written: the same checks the daemon runs when it loads the file, phrased as flags, so the problem is met while the user
 * is at the keyboard. `from`/`cleared` (a type change) are said in the message, so the user sees why the companion is needed.
 */
export function entryProblems(entry: SubscriberConfig, context: { from?: SubscriberConfig['type']; cleared?: readonly string[] }): string[] {
  const changed = context.from !== undefined && context.from !== entry.type;
  const because = changed ? ` (the subscriber was ${context.from}${(context.cleared ?? []).length > 0 ? `; cleared: ${(context.cleared ?? []).join(', ')}` : ''})` : '';
  if (entry.type === 'cli') {
    if (!entry.command) {
      return [`--command is required for type: cli${because}`];
    }
    // A command with {{ }} placeholders runs without a shell: refuse here what the loader would refuse later
    const template = findTemplateProblem(entry.command);
    return template === undefined ? [] : [`--command: ${template}`];
  }
  if (entry.type === 'http' && !entry.url) {
    return [`--url is required for type: http${because}`];
  }
  return [];
}

/**
 * The entry written to subscribers.yml for a set of flags. On add (no `previous`) it is built from the flags; on edit, `previous` is merged
 * with them (see mergeSubscriberEntry), so nothing the flags do not mention is dropped.
 */
export function buildSubscriberEntry(config: Partial<SubscriberConfig>, previous?: SubscriberConfig): SubscriberConfig {
  if (previous !== undefined) {
    const merged = mergeSubscriberEntry(previous, { config, unset: [], given: new Set() });
    if ('errors' in merged) {
      throw new Error(merged.errors.join('; '));
    }
    return merged.entry;
  }
  const entry: SubscriberConfig = { type: config.type ?? 'cli' };
  if (config.name) {
    entry.name = config.name;
  }
  if (entry.type === 'action') {
    // An action takes none of the cli/http fields (the loader refuses them)
    if (config.action) {
      entry.action = config.action;
    }
    entry.with = config.with ?? {};
  } else {
    if (config.command) {
      entry.command = config.command;
    }
    if (config.url) {
      entry.url = config.url;
    }
    if (config.method) {
      entry.method = config.method;
    }
    if (config.headers && Object.keys(config.headers).length > 0) {
      entry.headers = config.headers;
    }
  }
  if (config.timeout) {
    entry.timeout = config.timeout;
  }
  if (config.retries !== undefined) {
    entry.retries = config.retries;
  }
  if (config.backoff) {
    entry.backoff = config.backoff;
  }
  if (config.when) {
    entry.when = config.when;
  }
  return entry;
}

/** Which subscriber of an event `queue sub remove|edit` targets: --index wins, else --name; an error says what to fix. */
export function locateSubscriber(subs: SubscriberConfig[], event: string, args: string[]): { index: number } | { error: string } {
  const flagValue = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    const value = at === -1 ? undefined : args[at + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  };
  const indexText = flagValue('--index');
  if (indexText !== undefined) {
    const index = Number(indexText);
    if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(index)) {
      return { error: '--index must be a non-negative integer' };
    }
    if (index >= subs.length) {
      return { error: `No subscriber at index ${index} for event '${event}' (found ${subs.length})` };
    }
    return { index };
  }
  const name = flagValue('--name');
  if (name === undefined) {
    return { error: '--index <N> or --name <name> is required' };
  }
  const index = subs.findIndex((s) => s.name === name);
  if (index === -1) {
    const names = subs.flatMap((s) => (s.name === undefined ? [] : [s.name]));
    return { error: `No subscriber named '${name}' for event '${event}' (named: ${names.length === 0 ? 'none, use --index' : names.join(', ')})` };
  }
  return { index };
}

/**
 * `queue sub edit <event> --index N --name x` with no other flag only names the entry (the fix the unnamed-subscriber warning gives);
 * undefined when the flags ask for more, then edit replaces the entry.
 */
export function renameSubscriber(subs: SubscriberConfig[], index: number, config: Partial<SubscriberConfig>): { subs: SubscriberConfig[] } | { error: string } | undefined {
  const keys = Object.keys(config);
  if (config.name === undefined || keys.length !== 1) {
    return undefined;
  }
  const clash = subs.findIndex((s, i) => i !== index && s.name === config.name);
  if (clash !== -1) {
    return { error: `The name '${config.name}' is already used by the subscriber at index ${clash} of this event: names are unique per event within a file` };
  }
  return { subs: subs.map((s, i) => (i === index ? { ...s, name: config.name } : s)) };
}

/** The warning for a subscriber of a subscribers.yml without a name (the file will not load), with the command that fixes it. */
export function unnamedLine(event: string, index: number, scope: 'global' | 'project'): string {
  return (
    `[warn] subscriber ${event}[${index}] has no name: a name is required, so the daemon refuses to load this file. ` +
    `Fix: queue sub edit ${event} --index ${index} --name <name>${scope === 'project' ? ' --scope project' : ''}`
  );
}

/** What a listing prints as the target of a subscriber: its command, its URL or `action:<name>`. */
export function subscriberTarget(sub: { type: string; command?: string; url?: string; action?: string }): string | undefined {
  if (sub.type === 'action') {
    return `action:${sub.action ?? '?'}`;
  }
  return sub.type === 'cli' ? sub.command : sub.url;
}
