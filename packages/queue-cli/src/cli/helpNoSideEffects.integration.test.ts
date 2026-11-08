/**
 * `--help` of any command prints help and exits 0 without side effects: it never starts or stops a daemon, never pushes, never updates.
 * Found by review: `queue stop --help`, `queue start --help`, `queue relay start|stop --help` ran the action; `queue dlq` alone printed an error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { runQueueCli } from '../testing/runCli.js';
import { missingRelayYmlMessage } from './relayYmlTemplate.js';

let iso: IsolatedCliEnv;

beforeAll(() => {
  iso = createIsolatedCliEnv();
});

afterAll(() => {
  // A help that wrongly started a daemon must not leave it running behind the failure
  runQueueCli(iso.env, ['stop'], { cwd: iso.root });
  runQueueCli(iso.env, ['relay', 'stop'], { cwd: iso.root });
  iso.cleanup();
});

/** Every command (and subcommand) of `queue --help`, each with the help flag. */
const HELP_INVOCATIONS: string[][] = [
  ['start', '--help'],
  ['start', '-h'],
  ['stop', '--help'],
  ['stop', '-h'],
  ['push', '--help'],
  ['retry', '--help'],
  ['replay', '--help'],
  ['status', '--help'],
  ['list-subscribers', '--help'],
  ['logs', '--help'],
  ['history', '--help'],
  ['dlq', '--help'],
  ['dlq', 'list', '--help'],
  ['dlq', 'replay', '--help'],
  ['dlq', 'clear', '--help'],
  ['sub', '--help'],
  ['sub', 'list', '--help'],
  ['sub', 'add', '--help'],
  ['sub', 'edit', '--help'],
  ['sub', 'remove', '--help'],
  ['relay', '--help'],
  ['relay', 'start', '--help'],
  ['relay', 'start', '-h'],
  ['relay', 'stop', '--help'],
  ['relay', 'stop', '-h'],
  ['relay', 'status', '--help'],
  ['relay', 'webhook', '--help'],
  ['relay', 'webhook', 'list', '--help'],
  ['relay', 'webhook', 'history', '--help'],
  ['events', '--help'],
  ['events', 'list', '--help'],
  ['events', 'show', '--help'],
  ['events', 'register', '--help'],
  ['wait', '--help'],
  ['wait', 'ci', '--help'],
  ['cli', '--help'],
  ['cli', 'self-check', '--help'],
  ['cli', 'update', '--help'],
  ['cli', 'logs', '--help'],
  ['cli', 'version', '--help'],
];

/** What a daemon, a relay or a push leaves behind in the config directory. */
const SIDE_EFFECT_ENTRIES = ['config.port', 'relay-daemon', 'wal.ndjson', 'dlq.ndjson', 'history'];

function sideEffects(): string[] {
  return readdirSync(iso.configDir).filter((entry) => SIDE_EFFECT_ENTRIES.includes(entry));
}

describe('--help of every command', () => {
  it.each(HELP_INVOCATIONS)('queue %s: prints help on stdout, exits 0, writes nothing on stderr and starts nothing', (...args) => {
    const result = runQueueCli(iso.env, args, { cwd: iso.root });

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout).toMatch(/queue/);
    // "[ok] daemon was not running", "[fail] ..." or "Usage: ..." on stderr mean the action (or its argument check) ran
    expect(result.stderr).toBe('');
    expect(sideEffects()).toEqual([]);
  });

  it('queue dlq with no subcommand prints the DLQ help (like relay, cli and sub), exit 0, nothing started', () => {
    const result = runQueueCli(iso.env, ['dlq'], { cwd: iso.root });

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('queue dlq - Dead Letter Queue management');
    expect(result.stderr).toBe('');
    expect(sideEffects()).toEqual([]);
  });

  it('`queue relay webhook list` without relay.yml shows the one shared relay.yml example', () => {
    const result = runQueueCli(iso.env, ['relay', 'webhook', 'list'], { cwd: iso.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(missingRelayYmlMessage(iso.configDir));
  });

  it('a running daemon is still running after `queue stop --help` and `queue start --help`', () => {
    const started = runQueueCli(iso.env, ['start'], { cwd: iso.root });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const before = JSON.parse(runQueueCli(iso.env, ['status', '--json'], { cwd: iso.root }).stdout) as { daemonRunning: boolean; pid: number };
      expect(before.daemonRunning).toBe(true);

      expect(runQueueCli(iso.env, ['stop', '--help'], { cwd: iso.root }).exitCode).toBe(0);
      const startHelp = runQueueCli(iso.env, ['start', '--help'], { cwd: iso.root });
      expect(startHelp.exitCode).toBe(0);
      expect(startHelp.stderr).toBe('');

      const after = JSON.parse(runQueueCli(iso.env, ['status', '--json'], { cwd: iso.root }).stdout) as { daemonRunning: boolean; pid: number };
      expect(after).toMatchObject({ daemonRunning: true, pid: before.pid });
    } finally {
      const stopped = runQueueCli(iso.env, ['stop'], { cwd: iso.root });
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      expect(existsSync(iso.configDir)).toBe(true);
    }
  });
});
