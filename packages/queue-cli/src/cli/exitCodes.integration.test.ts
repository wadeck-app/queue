/**
 * The exit codes the help documents (exitCodes.ts) against the real CLI: each row runs the bundled `queue` with arguments that reach
 * one documented outcome, and the exit code must be the expected one AND be one the command documents. A second test checks that every
 * documented non-zero code is reached by at least one row (or is explicitly listed as unreachable here, with the reason).
 * The bundle runs in a throwaway environment (createIsolatedCliEnv): own config dir, home, npm prefix and free ports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { createCliRunner } from '../testing/runCli.js';
import { testBundleFile } from '../testing/testBundle.js';
import { COMMAND_EXIT_CODES, documentedCodes } from './exitCodes.js';

let iso: IsolatedCliEnv;

beforeAll(() => {
  iso = createIsolatedCliEnv();
});

afterAll(() => {
  // Best effort: a daemon started by a row must not outlive the run
  spawnSync(process.execPath, [testBundleFile('queue.cjs'), 'stop'], { encoding: 'utf-8', timeout: 60_000, env: iso.env });
  iso.cleanup();
});

const runCli = createCliRunner(() => iso.env);

interface Row {
  /** The entry of COMMAND_EXIT_CODES this row exercises. */
  command: string;
  args: string[];
  expected: number;
  env?: Record<string, string>;
  /** Text the output must contain (stdout + stderr): the reason the user is given. */
  says?: string;
}

// Rows that need no daemon come first; the daemon is started by the first row that asks for it and stopped by the 'stop' row.
const ROWS: Row[] = [
  { command: 'push', args: ['push'], expected: 1, says: 'Usage: queue push' },
  { command: 'push', args: ['push', 'onX', 'not-json'], expected: 1, says: 'Invalid JSON payload' },
  { command: 'retry', args: ['retry'], expected: 1, says: 'Usage: queue retry' },
  { command: 'replay', args: ['replay'], expected: 1, says: 'Usage: queue replay' },
  { command: 'replay', args: ['replay', 'no-such-event'], expected: 1, says: 'No history entry found' },
  { command: 'status', args: ['status', '--json'], expected: 0, says: '"daemonRunning":false' },
  { command: 'status', args: ['status', '--project', 'no-such-project-zzz'], expected: 1, says: 'no-such-project-zzz' },
  { command: 'stop', args: ['stop'], expected: 0, says: 'daemon was not running' },
  { command: 'dlq', args: ['dlq', 'clear', '--id'], expected: 1, says: '--id needs a value' },
  { command: 'dlq', args: ['dlq', 'replay'], expected: 1, says: 'Usage: queue dlq replay' },
  { command: 'dlq', args: ['dlq', 'bogus'], expected: 1, says: 'Unknown dlq subcommand' },
  { command: 'sub', args: ['sub', 'list', '--scope', 'bogus'], expected: 1, says: '--scope must be global or project' },
  { command: 'sub', args: ['sub', 'bogus'], expected: 1, says: 'Unknown sub subcommand' },
  { command: 'sub', args: ['sub', 'list', '--scope', 'global', '--json'], expected: 0 },
  { command: 'start', args: ['start'], expected: 1, env: { QUEUE_DAEMON_PORT: 'not-a-port' }, says: 'QUEUE_DAEMON_PORT' },
  { command: 'relay', args: ['relay', 'bogus'], expected: 1, says: 'Unknown relay subcommand' },
  { command: 'relay', args: ['relay', 'status', '--json'], expected: 0, says: '"relayRunning":false' },
  { command: 'relay', args: ['relay', 'stop'], expected: 0, says: 'was not running' },
  { command: 'relay', args: ['relay', 'start'], expected: 1, says: 'No relay.yml' },
  { command: 'logs', args: ['logs'], expected: 0 },
  { command: 'history', args: ['history', '--limit'], expected: 1, says: '--limit needs' },
  { command: 'history', args: ['history', '--json'], expected: 0 },
  { command: 'history', args: ['history', '--event-id', 'no-such-id'], expected: 1, says: 'No history entry for eventId' },
  { command: 'events', args: ['events', 'list', '--json'], expected: 0 },
  { command: 'events', args: ['events', 'show', 'no.such.event'], expected: 4 },
  { command: 'events', args: ['events', 'register', '--source', 'zz', '--file', 'no-such-file.json'], expected: 1 },
  { command: 'wait', args: ['wait'], expected: 4 },
  { command: 'wait', args: ['wait', 'onNeverHappens.test', '--timeout', '1s'], expected: 2, says: 'no --name' },
  { command: 'wait ci', args: ['wait', 'ci', 'not-a-sha'], expected: 4, says: 'not a commit SHA' },
  { command: 'wait', args: ['wait', 'onNeverHappens.test', '--name', 'nodot'], expected: 4, says: 'must look like <who>.<what>' },
  { command: 'wait ci', args: ['wait', 'ci', '--name', 'Bad.Name'], expected: 4, says: 'must look like <who>.<what>' },
  { command: 'waiters', args: ['waiters', '--json'], expected: 0, says: '[]' },
  { command: 'waiters', args: ['waiters', '--history'], expected: 0, says: 'timeout' },
  { command: 'waiters', args: ['waiters', '--histroy'], expected: 1, says: "did you mean '--history'?" },
  { command: 'wait', args: ['wait', 'onNeverHappens.test', '--timout', '1s'], expected: 4, says: "did you mean '--timeout'?" },
  { command: 'wait ci', args: ['wait', 'ci', '--timout', '5m'], expected: 4, says: "did you mean '--timeout'?" },
  { command: 'cli', args: ['cli', 'bogus'], expected: 1, says: 'Unknown cli subcommand' },
  { command: 'cli', args: ['cli', 'update'], expected: 1 },
  { command: 'unknown', args: ['totally-unknown-xyz'], expected: 1, says: 'Unknown command' },
  // These start the daemon of this isolated environment
  { command: 'list-subscribers', args: ['list-subscribers', '--json'], expected: 0 },
  { command: 'dlq', args: ['dlq', 'list'], expected: 0 },
  { command: 'dlq', args: ['dlq', 'clear'], expected: 0, says: 'the DLQ was already empty' },
  { command: 'dlq', args: ['dlq', 'clear', '--id', 'no-such-entry'], expected: 1, says: 'no DLQ entry with id no-such-entry' },
  { command: 'dlq', args: ['dlq', 'replay', '--id', 'no-such-entry'], expected: 1, says: 'no DLQ entry with id no-such-entry' },
  { command: 'retry', args: ['retry', '--event', 'no-such-wal-id'], expected: 1, says: 'no WAL entry with id no-such-wal-id' },
  { command: 'push', args: ['push', 'onExitCodes.test', '{"a":1}'], expected: 0 },
  { command: 'push', args: ['push', 'queue.dlq.added', '{}'], expected: 1, says: 'queue.' },
  { command: 'wait', args: ['wait', 'onExitCodes.test', '--since', '10m', '--timeout', '30s'], expected: 0 },
  { command: 'status', args: ['status', '--json'], expected: 0, says: '"daemonRunning":true' },
  { command: 'start', args: ['start'], expected: 0, says: 'already running' },
  { command: 'stop', args: ['stop'], expected: 0, says: 'daemon stopped' },
  { command: 'status', args: ['status', '--json'], expected: 0, says: '"daemonRunning":false' },
];

// Documented codes no row can reach here, each with the reason. Everything else documented must be reached by a row above.
const UNREACHED: Record<string, string> = {
  'retry:0': 'needs a failed delivery in the WAL (covered by the daemon tests and QueueCommands.test.ts)',
  'replay:0': 'needs a recorded event with a payload and a subscriber run (covered by QueueIndex.integration.test.ts)',
  'stop:1': 'needs a daemon that ignores quit (covered by daemonStop.test.ts)',
  'wait ci:0': 'needs a GitHub run (covered by ciWait*.test.ts)',
  'wait ci:1': 'needs a GitHub run (covered by ciWait*.test.ts)',
  'wait ci:2': 'needs a GitHub run (covered by ciWait*.test.ts)',
  'wait ci:3': 'needs the relay (covered by ciWait.integration.test.ts)',
  'list-subscribers:1': 'needs a daemon that cannot start (covered by the start rows)',
  'cli:0': 'covered by QueueIndex.integration.test.ts (self-check)',
};

// The rows run once, in order (the later ones need the daemon the earlier ones started); every test below reads this result,
// none depends on another test having run (each passes when run alone)
const reached = new Set<string>();
const failures: string[] = [];

describe('the exit codes the help documents are the ones the CLI returns', () => {
  beforeAll(() => {
    for (const row of ROWS) {
      const documented = documentedCodes(row.command);
      const label = `queue ${row.args.join(' ')}`;
      if (!documented.includes(row.expected)) {
        failures.push(`${label}: the row expects ${row.expected} but "${row.command}" documents ${documented.join(', ')}`);
        continue;
      }
      const result = runCli(row.args, row.env);
      if (result.exitCode !== row.expected) {
        failures.push(`${label}: exit ${result.exitCode}, expected ${row.expected}\n  stdout: ${result.stdout.trim()}\n  stderr: ${result.stderr.trim()}`);
        continue;
      }
      if (row.says !== undefined && !(result.stdout + result.stderr).includes(row.says)) {
        failures.push(`${label}: exit ${row.expected} but the output does not say "${row.says}"\n  stdout: ${result.stdout.trim()}\n  stderr: ${result.stderr.trim()}`);
        continue;
      }
      reached.add(`${row.command}:${row.expected}`);
    }
  });

  it('runs every row with the expected code, a code the command documents, and a reason on stderr/stdout', () => {
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('every documented non-zero code is reached by a row, or is listed as unreachable with its reason', () => {
    const missing: string[] = [];
    for (const entry of COMMAND_EXIT_CODES) {
      for (const code of documentedCodes(entry.command)) {
        const key = `${entry.command}:${code}`;
        const excused = key in UNREACHED;
        if (!reached.has(key) && !excused) {
          missing.push(key);
        }
      }
    }
    expect(missing, `documented but never returned by any row: ${missing.join(', ')}`).toEqual([]);
  });

  it('an excuse in UNREACHED is not stale: it names a documented code that no row reaches', () => {
    const stale = Object.keys(UNREACHED).filter((key) => {
      const [command, code] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
      return !documentedCodes(command).includes(code) || reached.has(key);
    });
    expect(stale, `remove these from UNREACHED: ${stale.join(', ')}`).toEqual([]);
  });
});
