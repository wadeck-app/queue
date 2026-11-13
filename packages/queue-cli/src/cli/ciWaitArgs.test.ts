/**
 * `queue wait ci` arguments: a value flag without its value, with an empty value, in the `--flag=value` form or given twice is a usage error
 * (exit 4 through queueWaitCommand), never a silent fallback to the default (found by review: `--timeout` alone and `--timeout=5m` waited 30 minutes).
 */
import { describe, it, expect } from 'vitest';
import { parseCiWaitArgs } from './ciWaitArgs.js';

function message(args: string[]): string {
  const parsed = parseCiWaitArgs(args);
  if (parsed.ok) {
    throw new Error(`expected a usage error for ${JSON.stringify(args)}, got ${JSON.stringify(parsed)}`);
  }
  return parsed.message;
}

describe('parseCiWaitArgs', () => {
  it('reads the sha, the single-value flags, the repeatable --workflow and the switches', () => {
    expect(parseCiWaitArgs(['abc1234', '--repo', 'o/r', '--workflow', 'CI', '--workflow', 'Lint', '--timeout', '5m', '--settle', '2s', '--json', '--no-infer'])).toEqual({
      ok: true,
      sha: 'abc1234',
      repo: 'o/r',
      workflows: ['CI', 'Lint'],
      timeout: '5m',
      settle: '2s',
      json: true,
      noInfer: true,
    });
  });

  it('a flag before the sha does not hide the sha, and no flag means no value', () => {
    expect(parseCiWaitArgs(['--workflow', 'CI', 'abc1234'])).toMatchObject({ ok: true, sha: 'abc1234', workflows: ['CI'] });
    expect(parseCiWaitArgs([])).toEqual({ ok: true, workflows: [], json: false, noInfer: false });
  });

  it.each([
    [['--timeout'], '--timeout needs'],
    [['abc1234', '--timeout'], '--timeout needs'],
    [['--timeout', '--json'], '--timeout needs'],
    [['--timeout', ''], '--timeout needs'],
    [['--repo'], '--repo needs'],
    [['--repo', ''], '--repo needs'],
    [['--workflow'], '--workflow needs'],
    [['--workflow', '--json'], '--workflow needs'],
    [['--settle'], '--settle needs'],
  ])('%j is a usage error naming the flag and what to write', (args, expected) => {
    expect(message(args)).toContain(expected);
  });

  it('refuses the --flag=value form and says to write the flag and its value apart', () => {
    expect(message(['--timeout=5m'])).toContain('--timeout 5m');
    expect(message(['--repo=o/r'])).toContain('--repo o/r');
    expect(message(['--workflow=CI'])).toContain('--workflow CI');
  });

  it('refuses a single-value flag given twice: the second would be silently ignored', () => {
    expect(message(['--timeout', '5m', '--timeout', '10m'])).toContain('--timeout is given twice');
    expect(message(['--repo', 'a/b', '--repo', 'c/d'])).toContain('--repo is given twice');
  });

  it('a second positional is a usage error, not a silently ignored word', () => {
    expect(message(['abc1234', 'def5678'])).toContain("unexpected argument 'def5678'");
  });
});

describe('parseCiWaitArgs: an unknown option is a usage error', () => {
  it('names the option and suggests the closest valid one', () => {
    const text = message(['--timout', '5m']);
    expect(text).toContain("unknown option '--timout'");
    expect(text).toContain("did you mean '--timeout'?");
  });

  it('refuses an unknown switch next to a valid sha', () => {
    expect(message(['abc1234', '--jsno'])).toContain("did you mean '--json'?");
  });
});

describe('parseCiWaitArgs: --since', () => {
  it('is carried as written (the value is parsed where the clock is known) and absent otherwise', () => {
    expect(parseCiWaitArgs(['abc1234', '--since', '3d'])).toMatchObject({ ok: true, since: '3d' });
    const without = parseCiWaitArgs(['abc1234']);
    expect(without.ok && 'since' in without).toBe(false);
  });

  it('refuses a missing value, a repeat and the --since=x form', () => {
    expect(message(['--since'])).toContain('--since needs');
    expect(message(['--since', '--json'])).toContain('--since needs');
    expect(message(['--since', '3d', '--since', '4d'])).toContain('--since is given twice');
    expect(message(['--since=3d'])).toContain('--since 3d');
  });
});

describe('parseCiWaitArgs: --name', () => {
  it('is carried when valid and absent otherwise', () => {
    expect(parseCiWaitArgs(['abc1234', '--name', 'w-agent-wake.ci-abc1234'])).toMatchObject({ ok: true, name: 'w-agent-wake.ci-abc1234' });
    const without = parseCiWaitArgs(['abc1234']);
    expect(without.ok && 'name' in without).toBe(false);
  });

  it('refuses an invalid name with the rule and an example', () => {
    const text = message(['--name', 'nodot']);
    expect(text).toContain('must look like <who>.<what>');
    expect(text).toContain('e.g. w-agent-wake.ab12cd34');
  });

  it('refuses a missing value, a repeat and the --name=x form', () => {
    expect(message(['--name'])).toContain('--name');
    expect(message(['--name', 'a.b', '--name', 'c.d'])).toContain('--name');
    expect(message(['--name=a.b'])).toContain('--name a.b');
  });
});
