import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';

// The bundled CLI against a throwaway config dir: `queue sub add|edit|list` with type action. No daemon is needed (the --scope flag reads the file).

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const bundlePath = join(rootDir, 'dist-bundle/queue.cjs');

let iso: IsolatedCliEnv;
let subscribersFile: string;

beforeAll(() => {
  execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
    windowsHide: true,
  });
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

function readSubscribers(): Record<string, Array<Record<string, unknown>>> {
  return (yamlLoad(readFileSync(subscribersFile, 'utf-8')) as { subscribers: Record<string, Array<Record<string, unknown>>> }).subscribers;
}

describe('queue sub add --type action (integration)', () => {
  it('writes an emit action with a nested payload and lists it as action:emit', () => {
    const add = runCli(['sub', 'add', 'it.source', '--name', 'relay', '--type', 'action', '--action', 'emit', '--set', 'event=it.target', '--set', 'payload.text={{ payload.text }}']);
    expect(add.exitCode, add.stderr).toBe(0);
    expect(readSubscribers()['it.source']![0]).toEqual({ type: 'action', name: 'relay', action: 'emit', with: { event: 'it.target', payload: { text: '{{ payload.text }}' } } });

    const list = runCli(['sub', 'list', '--scope', 'global', '--json']);
    expect(list.exitCode, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ subscriberId: 'relay', type: 'action', action: 'emit', with: { event: 'it.target', payload: { text: '{{ payload.text }}' } } })]);
  });

  it('refuses an unknown action and names the available ones, writing nothing', () => {
    const add = runCli(['sub', 'add', 'it.source', '--name', 'x', '--type', 'action', '--action', 'nope']);
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toContain('unknown action "nope"');
    expect(add.stderr).toContain('Available actions: emit');
  });

  it('refuses a with block the plugin rejects, with the fix', () => {
    const add = runCli(['sub', 'add', 'it.source', '--name', 'x', '--type', 'action', '--action', 'emit', '--set', 'event=agent.*']);
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toContain('concrete event name');
  });

  it('refuses an action that closes a loop with another (no when anywhere), and writes nothing', () => {
    expect(runCli(['sub', 'add', 'on.a', '--name', 'a', '--type', 'action', '--action', 'emit', '--set', 'event=on.b']).exitCode).toBe(0);
    const closing = runCli(['sub', 'add', 'on.b', '--name', 'b', '--type', 'action', '--action', 'emit', '--set', 'event=on.a']);
    expect(closing.exitCode).toBe(1);
    expect(closing.stderr).toContain('action loop');
    expect(Object.keys(readSubscribers())).toEqual(['on.a']);
  });

  it('accepts the same loop with a when: and warns', () => {
    expect(runCli(['sub', 'add', 'on.a', '--name', 'a', '--type', 'action', '--action', 'emit', '--set', 'event=on.b']).exitCode).toBe(0);
    const closing = runCli(['sub', 'add', 'on.b', '--name', 'b', '--type', 'action', '--action', 'emit', '--set', 'event=on.a', '--when', 'payload.again=true']);
    expect(closing.exitCode, closing.stderr).toBe(0);
    expect(closing.stderr).toContain('possible action loop');
  });

  it('warns that the emitted event is declared by no program, and still writes', () => {
    const add = runCli(['sub', 'add', 'it.source', '--name', 'relay', '--type', 'action', '--action', 'emit', '--set', 'event=it.target']);
    expect(add.exitCode).toBe(0);
    expect(add.stderr).toContain("emits 'it.target'");
  });

  it('edit switches a cli entry to an action and drops the stale command', () => {
    expect(runCli(['sub', 'add', 'it.source', '--name', 'relay', '--type', 'cli', '--command', 'echo hi']).exitCode).toBe(0);
    const edit = runCli(['sub', 'edit', 'it.source', '--name', 'relay', '--type', 'action', '--action', 'emit', '--set', 'event=it.target']);
    expect(edit.exitCode, edit.stderr).toBe(0);
    expect(readSubscribers()['it.source']![0]).toEqual({ type: 'action', name: 'relay', action: 'emit', with: { event: 'it.target' } });
  });

  it('a file with action entries (numbers, booleans, nested objects in with) survives `queue sub edit` of a neighbour entry', () => {
    writeFileSync(
      subscribersFile,
      [
        'subscribers:',
        '  it.source:',
        '    - type: cli',
        '      name: neighbour',
        '      command: echo before',
        '    - type: action',
        '      name: relay',
        '      action: emit',
        '      with:',
        '        event: it.target',
        '        payload:',
        '          count: 3',
        '          flag: true',
        '          nested: { list: [1, "two", false], deep: { k: null } }',
        '          text: "{{ payload.text }}"',
        '',
      ].join('\n'),
    );
    const before = readSubscribers()['it.source']![1];
    const edit = runCli(['sub', 'edit', 'it.source', '--name', 'neighbour', '--type', 'cli', '--command', 'echo after']);
    expect(edit.exitCode, edit.stderr).toBe(0);
    const entries = readSubscribers()['it.source']!;
    expect(entries[0]).toMatchObject({ name: 'neighbour', command: 'echo after' });
    // zod must not strip or coerce a value inside with
    expect(entries[1]).toEqual(before);
    expect((entries[1]!['with'] as { payload: { count: number } }).payload.count).toBe(3);
  });

  it('prints the usage of --type action and --set in the help', () => {
    const help = runCli(['sub', '--help']);
    expect(help.stdout).toContain('--type action --action <name>');
    expect(help.stdout).toContain('--set key=value');
  });
});
