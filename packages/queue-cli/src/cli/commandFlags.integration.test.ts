/**
 * The flags of every command in the table (commandFlags.ts) against the real CLI: an option nobody knows, a value flag without its value and a stray
 * word each exit 1 with the reason and the usage line, and nothing is started, pushed or changed (the check runs before the action).
 * One row per command of the table, so a command added to it is exercised without writing a test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { runQueueCli } from '../testing/runCli.js';
import { COMMAND_FLAGS } from './commandFlags.js';

let iso: IsolatedCliEnv;

beforeAll(() => {
  iso = createIsolatedCliEnv();
});

afterAll(() => {
  // A check that wrongly let the action run must not leave a daemon behind the failure
  runQueueCli(iso.env, ['stop'], { cwd: iso.root });
  runQueueCli(iso.env, ['relay', 'stop'], { cwd: iso.root });
  iso.cleanup();
});

/** What a daemon, a relay, a push or a replay leaves behind in the config directory. */
const SIDE_EFFECT_ENTRIES = ['config.port', 'relay-daemon', 'wal.ndjson', 'dlq.ndjson', 'history'];

function run(key: string, args: string[]) {
  return runQueueCli(iso.env, [...key.split(' '), ...args], { cwd: iso.root });
}

function expectRefused(key: string, args: string[], reason: string): void {
  const result = run(key, args);
  expect(result.exitCode, `queue ${key} ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).toContain(`Usage: ${COMMAND_FLAGS[key]!.usage}`);
  expect(readdirSync(iso.configDir).filter((entry) => SIDE_EFFECT_ENTRIES.includes(entry))).toEqual([]);
}

describe.each(Object.entries(COMMAND_FLAGS))('queue %s', (key, entry) => {
  it('refuses an unknown option with the usage', () => {
    expectRefused(key, ['--zzzzzzzzzz'], "unknown option '--zzzzzzzzzz'");
  });

  it('refuses a stray word with the usage', () => {
    const words = Array.from({ length: entry.maxPositionals + 1 }, (_, i) => `word${i}`);
    expectRefused(key, words, `unexpected argument 'word${entry.maxPositionals}'`);
  });

  const flag = entry.spec.values[0];
  // a command without value flag has nothing to test here (no test is generated, none is skipped)
  if (flag !== undefined) {
    it('refuses a value flag without its value with the usage', () => {
      expectRefused(key, [flag], `${flag} needs`);
    });
  }
});

describe('queue replay reads its eventId wherever the flag is', () => {
  it('takes the word that is not a flag value for the eventId (--cwd first used to make "--cwd" the id)', () => {
    const result = runQueueCli(iso.env, ['replay', '--cwd', iso.root, 'no-such-event'], { cwd: iso.root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No history entry found for eventId no-such-event');
  });
});
