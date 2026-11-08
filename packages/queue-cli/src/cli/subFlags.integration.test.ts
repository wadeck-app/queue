import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { testBundleFile } from '../testing/testBundle.js';

// The bundled CLI against a throwaway config dir (R4b): flags that used to be ignored, the object form of an event, the table of exit codes.
// None of these commands needs a daemon: each is refused (or answered) before one would be started.

const bundlePath = testBundleFile('queue.cjs');

let iso: IsolatedCliEnv;
let subscribersFile: string;

beforeAll(() => {
  iso = createIsolatedCliEnv();
  subscribersFile = join(iso.configDir, 'subscribers.yml');
});

afterAll(() => {
  iso.cleanup();
});

beforeEach(() => {
  rmSync(subscribersFile, { force: true });
});

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [bundlePath, ...args], { encoding: 'utf-8', timeout: 300_000, env: iso.env });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 };
}

const OBJECT_FORM = ['# my subscribers', 'subscribers:', '  build.>:', '    cwd: sub', '    commands:', '      - type: http', '        name: hook', '        url: http://example.test/hook', '        notes: keep me', ''].join('\n');

describe('value-taking flags of push, replay and sub (bundle)', () => {
  it.each([
    [['push', 'ev', '{}', '--timeout'], '--timeout needs a duration'],
    [['push', 'ev', '{}', '--timeout', '5x'], 'Invalid timeout'],
    [['replay', 'abc', '--cwd'], '--cwd needs a directory'],
    [['sub', 'add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--retry', '3'], "unknown option '--retry'"],
    [['sub', 'add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--retries', '5abc'], '--retries must be a whole number'],
    [['sub', 'add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--scope'], '--scope needs a value'],
    [['sub', 'list', '--scope'], '--scope needs a value'],
    [['sub', 'add', 'dep.pub*', '--name', 'x', '--type', 'cli', '--command', 'echo'], 'mixes a wildcard'],
  ])('%j exits 1 and says "%s"', (args, expected) => {
    const result = runCli(args);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(expected);
  });

  it('queue events list --match with a pattern that never matches exits 4', () => {
    const result = runCli(['events', 'list', '--match', 'on.>.x']);
    expect(result.exitCode, result.stderr).toBe(4);
    expect(result.stderr).toContain('must be the last one');
  });
});

describe('queue sub on a file with an event in the object form and a comment (bundle)', () => {
  it('add of a new event keeps the file as it was and the unknown key is reported by list', () => {
    writeFileSync(subscribersFile, OBJECT_FORM);
    const add = runCli(['sub', 'add', 'deploy.done', '--name', 'notify', '--type', 'cli', '--command', 'echo done']);
    expect(add.exitCode, add.stderr).toBe(0);
    const after = readFileSync(subscribersFile, 'utf-8');
    expect(after.startsWith(OBJECT_FORM)).toBe(true);
    const list = runCli(['sub', 'list', '--scope', 'global', '--json']);
    expect(list.exitCode, list.stderr).toBe(0);
    expect(list.stderr).toContain("unknown key 'notes'");
    expect((JSON.parse(list.stdout) as Array<{ subscriberId: string }>).map((s) => s.subscriberId)).toEqual(['hook', 'notify']);
  });

  it('edit of that event is refused with --rewrite as the way out, then goes through without crashing', () => {
    writeFileSync(subscribersFile, OBJECT_FORM);
    const refused = runCli(['sub', 'edit', 'build.>', '--name', 'hook', '--timeout', '5s']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('--rewrite');
    expect(refused.stderr).not.toContain('Fatal error');
    expect(readFileSync(subscribersFile, 'utf-8')).toBe(OBJECT_FORM);
    const done = runCli(['sub', 'edit', 'build.>', '--name', 'hook', '--timeout', '5s', '--rewrite']);
    expect(done.exitCode, done.stderr).toBe(0);
    const text = readFileSync(subscribersFile, 'utf-8');
    expect(text).toContain('commands:');
    expect(text).toContain('timeout: 5s');
    expect(text).toContain('notes: keep me');
  });
});
