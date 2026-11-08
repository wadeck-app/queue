/**
 * Every flag of every `queue` command that reads flags goes through one table (commandFlags.ts) and one strict scanner. The cases are generated from the
 * table, so a command or a flag added to it is covered without writing a test; the list of keys is also written here, so a command removed from the
 * table (and its flags read loosely again) fails a test.
 */
import { describe, it, expect } from 'vitest';
import { COMMAND_FLAGS, checkCommandFlags } from './commandFlags.js';
import { RELAY_WEBHOOK_HELP, commandHelp, usageText } from './QueueIndex.js';

const EXPECTED_KEYS = [
  'push', 'retry', 'replay', 'status', 'list-subscribers', 'dlq list', 'dlq replay', 'dlq clear', 'start', 'stop', 'relay start', 'relay stop', 'relay status',
  'relay webhook list', 'relay webhook history', 'logs', 'cli logs', 'cli version', 'cli self-check', 'history', 'waiters',
];

/** The words of a key as typed after `queue` (`relay webhook history` -> command `relay`, rest `webhook history`). */
function split(key: string): { command: string; rest: string[] } {
  const [command, ...rest] = key.split(' ');
  return { command: command!, rest };
}

function check(key: string, args: string[]) {
  const { command, rest } = split(key);
  return checkCommandFlags(command, [...rest, ...args]);
}

/** A value that is a valid word for any flag of the table. */
const SOME_VALUE = 'x1';

describe('the table of commands', () => {
  it('lists exactly the commands that read flags with the strict scanner', () => {
    expect(Object.keys(COMMAND_FLAGS).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('prints, under every reason, a usage line that is the one of the help', () => {
    const help = usageText() + RELAY_WEBHOOK_HELP + commandHelp('cli', ["--help"]);
    for (const [key, entry] of Object.entries(COMMAND_FLAGS)) {
      expect(help, `usage of "${key}"`).toContain(entry.usage);
    }
  });

  it('a command outside the table is left to its own parser', () => {
    expect(checkCommandFlags('wait', ['x'])).toBeUndefined();
    expect(checkCommandFlags('sub', ['list'])).toBeUndefined();
    expect(checkCommandFlags('dlq', ['bogus'])).toBeUndefined();
    expect(checkCommandFlags('relay', ['bogus'])).toBeUndefined();
  });
});

describe.each(Object.entries(COMMAND_FLAGS))('queue %s', (key, entry) => {
  const values = entry.spec.values;
  const switches = entry.spec.switches ?? [];

  it('accepts no argument at all, and every flag with a value', () => {
    // a command with a mandatory positional is checked by its own handler: the scanner only refuses what is wrong
    expect(check(key, [])?.problem).toBeUndefined();
    for (const flag of values) {
      expect(check(key, [flag, SOME_VALUE])?.problem, flag).toBeUndefined();
    }
    for (const flag of switches) {
      expect(check(key, [flag])?.problem, flag).toBeUndefined();
    }
  });

  it('refuses an option nobody knows, suggests the closest and prints the usage', () => {
    const problem = check(key, ['--zzzzzzzzzz'])?.problem;
    expect(problem?.messages.join('\n')).toContain("unknown option '--zzzzzzzzzz'");
    expect(problem?.usage).toBe(entry.usage);
    for (const flag of [...values, ...switches].filter((candidate) => candidate.startsWith('--') && candidate.length > 4)) {
      // a one-letter typo of a real flag names that flag
      const typo = `${flag}x`;
      expect(check(key, [typo])?.problem?.messages.join('\n'), typo).toContain(`did you mean '${flag}'?`);
    }
  });

  it.each(values)('%s without its value, or followed by another flag, is refused and says what to write', (flag) => {
    for (const args of [[flag], [flag, '--zzz'], [flag, '']]) {
      const text = check(key, args)?.problem?.messages.join('\n');
      expect(text, JSON.stringify(args)).toContain(`${flag} needs`);
    }
  });

  it.each(values.filter((flag) => !(entry.spec.repeatable ?? []).includes(flag)))('%s given twice is refused: the first would win silently', (flag) => {
    expect(check(key, [flag, 'a1', flag, 'b2'])?.problem?.messages.join('\n')).toContain(`${flag} is given twice`);
  });

  it.each(values.filter((flag) => flag.startsWith('--') && !(entry.equalsForm ?? []).includes(flag)))('%s=value is refused and says to write them apart', (flag) => {
    expect(check(key, [`${flag}=v1`])?.problem?.messages.join('\n')).toContain(`${flag} v1`);
  });

  it.each((entry.equalsForm ?? []).map((flag) => [flag]))('%s=value is the form its parser reads: accepted', (flag) => {
    expect(check(key, [`${flag}=v1`])?.problem).toBeUndefined();
  });

  it(entry.maxPositionals === 0 ? 'refuses a stray word' : `refuses a word beyond the ${entry.maxPositionals} it takes`, () => {
    const words = Array.from({ length: entry.maxPositionals + 1 }, (_, i) => `word${i}`);
    expect(check(key, words)?.problem?.messages.join('\n')).toContain(`unexpected argument 'word${entry.maxPositionals}'`);
    if (entry.maxPositionals > 0) {
      expect(check(key, words.slice(0, entry.maxPositionals))?.positionals).toEqual(words.slice(0, entry.maxPositionals));
    }
  });
});

describe('positional words', () => {
  it('replay takes its eventId before or after the flag', () => {
    expect(checkCommandFlags('replay', ['ev1', '--cwd', '/x'])?.positionals).toEqual(['ev1']);
    expect(checkCommandFlags('replay', ['--cwd', '/x', 'ev1'])?.positionals).toEqual(['ev1']);
  });

  it('a negative number is a word, not an option (a push payload)', () => {
    expect(checkCommandFlags('push', ['onX', '-5'])).toEqual({ positionals: ['onX', '-5'] });
  });

  it('what follows -- is never a flag', () => {
    expect(checkCommandFlags('push', ['onX', '--', '--not-a-flag'])).toEqual({ positionals: ['onX', '--not-a-flag'] });
    expect(checkCommandFlags('push', ['onX', '--', 'a', 'b'])?.problem?.messages.join('\n')).toContain("unexpected argument 'b'");
  });

  it('push: --project=name is read by the project parser, --timeout=5m is refused', () => {
    expect(checkCommandFlags('push', ['onX', '{}', '--project=app'])?.problem).toBeUndefined();
    expect(checkCommandFlags('push', ['onX', '{}', '--timeout=5m'])?.problem?.messages.join('\n')).toContain('--timeout 5m');
  });
});

describe('the safe reading of a mistake', () => {
  it('dlq clear says nothing was cleared and how to clear everything on purpose', () => {
    const problem = checkCommandFlags('dlq', ['clear', '--idd', 'x'])?.problem;
    expect(problem?.hint).toContain("Nothing was cleared. To clear the whole DLQ, run 'queue dlq clear' without --id.");
  });
});
