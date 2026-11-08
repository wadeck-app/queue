import { scanFlags, type FlagSpec } from './flagScan.js';

/** What one command (or sub-command) accepts after its name; `usage` is the line printed under the reason. */
export interface CommandFlags {
  spec: FlagSpec;
  /** How many words that are neither a flag nor a flag value the command takes (an event name, an id...). */
  maxPositionals: number;
  usage: string;
  /** Value flags that may also be written `--flag=value` (the parser behind them reads that form). */
  equalsForm?: readonly string[];
  /** A sentence printed after the reasons when the safe reading of the mistake matters (nothing was done). */
  hint?: string;
}

const PROJECT_FLAGS = ['--project', '-p'] as const;
const PROJECT_NEEDS = { '--project': 'a project name, alias or id, e.g. --project my-app', '-p': 'a project name, alias or id, e.g. -p my-app' } as const;
const NONE: FlagSpec = { values: [] };

/**
 * Every `queue` command that reads flags, by the words that name it (`push`, `dlq clear`, `relay webhook history`). One table, one scanner: a flag nobody
 * knows, a value flag without its value, one given twice and a stray word are all refused with the usage line, never ignored.
 * `wait`, `events` and `sub` have their own strict parsers (waitCli.ts, eventsCli.ts, subscriberFlags.ts); `cli update` forwards its arguments to the updater.
 */
export const COMMAND_FLAGS: Readonly<Record<string, CommandFlags>> = {
  push: {
    spec: {
      values: [...PROJECT_FLAGS, '--direction', '--timeout'],
      repeatable: ['--direction'],
      needs: { ...PROJECT_NEEDS, '--direction': 'to-parents or to-children (repeat the flag to give both)', '--timeout': 'a duration, e.g. --timeout 30s (30s, 5m, 1h)' },
    },
    maxPositionals: 2,
    usage: 'queue push <event> <json> [--project <name|alias|id>] [--direction to-parents|to-children]... [--timeout <duration>]',
    equalsForm: ['--project'],
  },
  retry: { spec: { values: ['--event'], needs: { '--event': 'a WAL id, e.g. --event <id> (the Pending page of the dashboard shows it)' } }, maxPositionals: 0, usage: 'queue retry --event <id>' },
  replay: {
    spec: { values: ['--cwd'], needs: { '--cwd': 'a directory, e.g. --cwd ../other-project' } },
    maxPositionals: 1,
    usage: 'queue replay <eventId> [--cwd <directory>]',
  },
  status: { spec: { values: [...PROJECT_FLAGS], switches: ['--json'], needs: PROJECT_NEEDS }, maxPositionals: 0, usage: 'queue status [--project <name|alias|id>] [--json]', equalsForm: ['--project'] },
  'list-subscribers': { spec: { values: [], switches: ['--json'] }, maxPositionals: 1, usage: 'queue list-subscribers [event] [--json]' },
  'dlq list': { spec: { values: [...PROJECT_FLAGS], needs: PROJECT_NEEDS }, maxPositionals: 0, usage: 'queue dlq list [--project <name|alias|id>]', equalsForm: ['--project'] },
  'dlq replay': { spec: { values: ['--id'], needs: { '--id': 'a value: the id of a DLQ entry (queue dlq list shows the ids)' } }, maxPositionals: 0, usage: 'queue dlq replay --id <id>', equalsForm: ['--id'] },
  'dlq clear': {
    spec: { values: ['--id'], needs: { '--id': 'a value: the id of a DLQ entry (queue dlq list shows the ids)' } }, maxPositionals: 0, usage: 'queue dlq clear [--id <id>]',
    equalsForm: ['--id'],
    hint: "Nothing was cleared. To clear the whole DLQ, run 'queue dlq clear' without --id.",
  },
  start: { spec: NONE, maxPositionals: 0, usage: 'queue start' },
  stop: { spec: NONE, maxPositionals: 0, usage: 'queue stop' },
  'relay start': { spec: NONE, maxPositionals: 0, usage: 'queue relay start|stop|status [--json]' },
  'relay stop': { spec: NONE, maxPositionals: 0, usage: 'queue relay start|stop|status [--json]' },
  'relay status': { spec: { values: [], switches: ['--json'] }, maxPositionals: 0, usage: 'queue relay start|stop|status [--json]' },
  'relay webhook list': { spec: { values: [], switches: ['--json'] }, maxPositionals: 0, usage: 'queue relay webhook list [--json]' },
  'relay webhook history': {
    spec: {
      values: ['--limit', '--event', '--source'],
      switches: ['--verified', '--rejected', '--payload', '--json'],
      needs: { '--limit': 'a number from 1 to 200, e.g. --limit 50', '--event': 'an event type, e.g. --event workflow_run', '--source': 'a source, e.g. --source github' },
    },
    maxPositionals: 0,
    usage: 'queue relay webhook history [--limit N] [--event TYPE] [--source S] [--verified | --rejected] [--payload] [--json]',
  },
  logs: { spec: { values: [], switches: ['--follow', '-f'] }, maxPositionals: 0, usage: 'queue logs [--follow]' },
  'cli logs': { spec: { values: [], switches: ['--follow', '-f'] }, maxPositionals: 0, usage: 'queue cli logs [--follow]' },
  'cli version': { spec: NONE, maxPositionals: 0, usage: 'queue cli version' },
  'cli self-check': { spec: NONE, maxPositionals: 0, usage: 'queue cli self-check' },
  history: {
    spec: {
      values: ['--event', '--event-id', '--subscriber', ...PROJECT_FLAGS, '--status', '--since', '--limit', '-n', '--offset'],
      switches: ['--json', '--follow', '-f'],
      needs: {
        ...PROJECT_NEEDS,
        '--event': 'an event name, e.g. --event deploy.done',
        '--event-id': 'the eventId shown by `queue history`',
        '--subscriber': 'a subscriber id, e.g. --subscriber notify',
        '--status': 'one of success|failed|dlq|filtered',
        '--since': 'a relative time, e.g. --since -3d (-Nd, -Nh, -Nm)',
        '--limit': 'a positive number, e.g. --limit 50',
        '-n': 'a positive number, e.g. -n 50',
        '--offset': 'a number, e.g. --offset 20',
      },
    },
    maxPositionals: 0,
    usage: 'queue history [--event <name>] [--event-id <id>] [--subscriber <id>] [--project <name|alias|id>] [--status success|failed|dlq|filtered] [--since <-Nd|-Nh|-Nm>] [--limit|-n <N>] [--offset <N>] [--follow|-f] [--json]',
    equalsForm: ['--project'],
  },
};

/** The words that name a command: `["relay","webhook","history"]` for `queue relay webhook history ...`. */
function commandKey(command: string, rest: readonly string[]): { key: string; args: readonly string[] } | undefined {
  const depth = command === 'relay' && rest[0] === 'webhook' ? 2 : ['dlq', 'relay', 'cli'].includes(command) ? 1 : 0;
  const key = [command, ...rest.slice(0, depth)].join(' ');
  return key in COMMAND_FLAGS ? { key, args: rest.slice(depth) } : undefined;
}

export interface CommandFlagsProblem {
  messages: string[];
  hint?: string;
  usage: string;
}

export interface CommandFlagsCheck {
  /** The words that are not a flag nor a flag value, in order. */
  positionals: string[];
  /** Set when the arguments are not usable: print the messages and the usage line, exit 1. */
  problem?: CommandFlagsProblem;
}

/**
 * Reads the flags of `queue <command> <rest...>` with the strict scanner. undefined for a command this table does not cover (the caller's own
 * parser stays in charge). A word after `--` is a positional, never a flag (a payload such as `-5`).
 */
export function checkCommandFlags(command: string, rest: readonly string[]): CommandFlagsCheck | undefined {
  const found = commandKey(command, rest);
  if (found === undefined) {
    return undefined;
  }
  const entry = COMMAND_FLAGS[found.key]!;
  const messages: string[] = [];
  const beforeSeparator = found.args.indexOf('--');
  const flagArgs = beforeSeparator === -1 ? found.args : found.args.slice(0, beforeSeparator);
  const afterSeparator = beforeSeparator === -1 ? [] : found.args.slice(beforeSeparator + 1);
  const expanded: string[] = [];
  for (const arg of flagArgs) {
    const joined = entry.spec.values.find((flag) => arg.startsWith(`${flag}=`));
    if (joined === undefined) {
      expanded.push(arg);
    } else if (entry.equalsForm?.includes(joined) === true) {
      expanded.push(joined, arg.slice(joined.length + 1));
    } else {
      messages.push(`${arg} is not supported: write the flag and its value apart, ${joined} ${arg.slice(joined.length + 1)}`);
    }
  }
  const scan = scanFlags(expanded, entry.spec, `queue ${found.key}`, [], Number.MAX_SAFE_INTEGER);
  messages.push(...scan.issues.map((issue) => issue.message));
  const positionals = [...scan.positionals, ...afterSeparator];
  if (positionals.length > entry.maxPositionals) {
    messages.push(`unexpected argument '${positionals[entry.maxPositionals]}' for 'queue ${found.key}'. If it belongs to the value before it, quote the whole value (a flag and its value are two words)`);
  }
  return { positionals, ...(messages.length > 0 && { problem: { messages, usage: entry.usage, ...(entry.hint !== undefined && { hint: entry.hint }) } }) };
}
