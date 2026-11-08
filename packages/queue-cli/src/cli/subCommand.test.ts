import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createActionRegistry } from '@wadeck-app/queue-core';
import { runSubCommand, type SubDeps } from './subCommand.js';

// `queue sub list|add|edit|remove` in-process: a throwaway config folder, a throwaway project registry, no daemon.

let dir: string;
let registryDir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-sub-cmd-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-sub-reg-'));
  file = join(dir, 'subscribers.yml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], overrides: Partial<SubDeps> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const deps: SubDeps = {
    configDir: dir,
    cwd: dir,
    registryDir,
    io: { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } } },
    isTTY: false,
    actions: () => createActionRegistry(),
    listFromDaemon: () => Promise.reject(new Error('the daemon must not be asked in this test')),
    waitingNow: () => '',
    help: 'HELP\n',
    ...overrides,
  };
  const code = await runSubCommand(args, deps);
  return { code, out, err };
}

const NL = '\n';
const lines = (...parts: string[]): string => parts.join(NL) + NL;

/** The fixture of the review: a comment, an unknown key and a typo, an event written in the object form. */
const COMMENTED = lines(
  '# Subscribers of my machine',
  'subscribers:',
  '  # notifies me',
  '  deploy.done:',
  '    - type: cli',
  '      name: notify',
  '      command: echo done   # inline comment',
  '      notes: keep me',
  '      timout: 5s',
  '  build.>:',
  '    cwd: sub',
  '    env: { A: "1" }',
  '    commands:',
  '      - type: http',
  '        name: hook',
  '        url: http://example.test/hook',
);

/** The same data without a comment. */
const PLAIN = lines(
  'subscribers:',
  '  deploy.done:',
  '    - type: cli',
  '      name: notify',
  '      command: echo done',
  '      notes: keep me',
  '      timout: 5s',
  '  build.>:',
  '    cwd: sub',
  '    env: { A: "1" }',
  '    commands:',
  '      - type: http',
  '        name: hook',
  '        url: http://example.test/hook',
);

type Doc = { subscribers: Record<string, any> };
const readDoc = (): Doc => yamlLoad(readFileSync(file, 'utf-8')) as Doc;

describe('R4b item 1 - queue sub add|edit|remove lose nothing and never crash on the object form', () => {
  it('add of a new event appends as text: the file keeps every byte, and the unknown keys are reported at once', async () => {
    writeFileSync(file, COMMENTED);
    const result = await run(['add', 'fresh.event', '--name', 'fresh', '--type', 'cli', '--command', 'echo new']);
    expect(result.code, result.err).toBe(0);
    const after = readFileSync(file, 'utf-8');
    expect(after.startsWith(COMMENTED)).toBe(true);
    expect(readDoc().subscribers['fresh.event']).toEqual([{ type: 'cli', name: 'fresh', command: 'echo new' }]);
    expect(result.err).toContain("[warn]");
    expect(result.err).toContain("unknown key 'timout'");
    expect(result.err).toContain("did you mean 'timeout'?");
    expect(result.err).toContain("unknown key 'notes'");
  });

  it('add to an event written in the object form no longer crashes (existing.some is not a function)', async () => {
    writeFileSync(file, PLAIN);
    const result = await run(['add', 'build.>', '--name', 'second', '--type', 'cli', '--command', 'echo 2']);
    expect(result.code, result.err).toBe(0);
    expect(result.err).not.toContain('is not a function');
    const doc = readDoc();
    expect(doc.subscribers['build.>']).toMatchObject({ cwd: 'sub', env: { A: '1' }, commands: [{ name: 'hook' }, { name: 'second', command: 'echo 2' }] });
    expect(doc.subscribers['deploy.done'][0]).toMatchObject({ notes: 'keep me', timout: '5s' });
  });

  it('remove from an object-form event no longer crashes and keeps the event cwd and env', async () => {
    writeFileSync(file, PLAIN);
    const result = await run(['remove', 'build.>', '--name', 'hook']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['build.>']).toEqual({ cwd: 'sub', env: { A: '1' }, commands: [] });
  });

  it('edit of an object-form event no longer crashes and writes it back in the same form', async () => {
    writeFileSync(file, PLAIN);
    const result = await run(['edit', 'build.>', '--name', 'hook', '--timeout', '7s']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['build.>']).toEqual({ cwd: 'sub', env: { A: '1' }, commands: [{ type: 'http', name: 'hook', url: 'http://example.test/hook', timeout: '7s' }] });
  });

  it('edit and remove keep the unknown keys of the other subscribers', async () => {
    writeFileSync(file, PLAIN);
    expect((await run(['edit', 'build.>', '--name', 'hook', '--timeout', '7s'])).code).toBe(0);
    expect((await run(['remove', 'build.>', '--name', 'hook'])).code).toBe(0);
    expect(readDoc().subscribers['deploy.done'][0]).toEqual({ type: 'cli', name: 'notify', command: 'echo done', notes: 'keep me', timout: '5s' });
  });

  it.each([
    ['add', ['add', 'deploy.done', '--name', 'second', '--type', 'cli', '--command', 'echo 2'], '# notifies me'],
    ['edit', ['edit', 'deploy.done', '--name', 'notify', '--timeout', '9s'], '# Subscribers of my machine'],
    ['remove', ['remove', 'build.>', '--name', 'hook'], '# inline comment'],
  ])('%s of a file with comments goes through without --rewrite and keeps every comment and unknown key', async (_name, args, comment) => {
    writeFileSync(file, COMMENTED);
    const result = await run(args);
    expect(result.code, result.err).toBe(0);
    expect(result.err).not.toContain('--rewrite');
    const after = readFileSync(file, 'utf-8');
    for (const kept of ['# Subscribers of my machine', '# notifies me', '# inline comment', 'notes: keep me', 'timout: 5s']) {
      expect(after).toContain(kept);
    }
    expect(after).toContain(comment);
    expect(readDoc().subscribers['build.>']).toMatchObject({ cwd: 'sub', env: { A: '1' } });
  });

  it('edit keeps the written text of values the command did not touch (date, hex, octal-looking, big integer) in unknown keys', async () => {
    const text = lines(
      'subscribers:',
      '  ev:',
      '    - type: cli',
      '      name: wake',
      '      command: echo wake',
      '      since: 2024-01-01',
      '      mask: 0x1F',
      '      mode: 0755',
      '      big: 12345678901234567890',
    );
    writeFileSync(file, text);
    const result = await run(['edit', 'ev', '--name', 'wake', '--timeout', '9s']);
    expect(result.code, result.err).toBe(0);
    const after = readFileSync(file, 'utf-8');
    for (const kept of ['since: 2024-01-01', 'mask: 0x1F', 'mode: 0755', 'big: 12345678901234567890', 'timeout: 9s']) {
      expect(after).toContain(kept);
    }
  });

  it('a change that cannot be made in place is refused with --rewrite as the way out, and --rewrite writes it (comments lost, said)', async () => {
    const merged = lines('# keep', 'x-base: &b', '  type: cli', '  command: echo base', '  timeout: 5s', 'subscribers:', '  a:', '    - <<: *b', '      name: one');
    writeFileSync(file, merged);
    const refused = await run(['edit', 'a', '--name', 'one', '--unset', 'timeout']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--rewrite');
    expect(refused.err).toContain('by hand');
    expect(readFileSync(file, 'utf-8')).toBe(merged);
    const done = await run(['edit', 'a', '--name', 'one', '--unset', 'timeout', '--rewrite']);
    expect(done.code, done.err).toBe(0);
    expect(done.err).toContain('comments');
    expect(readFileSync(file, 'utf-8')).not.toContain('#');
  });

  it('list reports the unknown keys with a suggestion', async () => {
    writeFileSync(file, PLAIN);
    const result = await run(['list', '--scope', 'global']);
    expect(result.code).toBe(0);
    expect(result.err).toContain("unknown key 'timout'");
    expect(result.err).toContain("did you mean 'timeout'?");
  });

  it('a first add creates the file', async () => {
    const result = await run(['add', 'a.b', '--name', 'x', '--type', 'cli', '--command', 'echo']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['a.b']).toEqual([{ type: 'cli', name: 'x', command: 'echo' }]);
  });
});

describe('R4b item 2 - queue sub edit merges the flags over the entry', () => {
  const HTTP = lines(
    'subscribers:',
    '  ev:',
    '    - type: http',
    '      name: hook',
    '      url: http://x/hook',
    '      method: PUT',
    '      headers: { A: "1", B: "2" }',
    '      timeout: 10s',
    '      retries: 7',
    '      backoff: linear',
    '      when: payload.a=1',
    '    - type: cli',
    '      name: other',
    '      command: echo',
  );

  it('--timeout alone changes the timeout (it used to answer "--type required")', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--name', 'hook', '--timeout', '5s']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['ev'][0]).toEqual({ type: 'http', name: 'hook', url: 'http://x/hook', method: 'PUT', headers: { A: '1', B: '2' }, timeout: '5s', retries: 7, backoff: 'linear', when: 'payload.a=1' });
  });

  it('--unset removes one field on purpose; --unset headers.A one header', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--index', '0', '--unset', 'when', '--unset', 'headers.A']);
    expect(result.code, result.err).toBe(0);
    const entry = readDoc().subscribers['ev'][0];
    expect(entry.when).toBeUndefined();
    expect(entry.headers).toEqual({ B: '2' });
    expect(entry.retries).toBe(7);
  });

  it('--name together with --unset does not drop the --unset (it used to be taken as a plain rename)', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--index', '0', '--name', 'renamed', '--unset', 'timeout']);
    expect(result.code, result.err).toBe(0);
    const entry = readDoc().subscribers['ev'][0];
    expect(entry.name).toBe('renamed');
    expect(entry.timeout).toBeUndefined();
  });

  it('changing the type without its companion is refused, says what to add and what would be cleared, and writes nothing', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--name', 'other', '--type', 'http']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--url is required for type: http');
    expect(result.err).toContain('cleared: command');
    expect(readFileSync(file, 'utf-8')).toBe(HTTP);
  });

  it('changing the type with its companion writes it and says what was cleared', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--name', 'other', '--type', 'http', '--url', 'http://y']);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain('cleared: command');
    expect(readDoc().subscribers['ev'][1]).toEqual({ type: 'http', name: 'other', url: 'http://y' });
  });

  it('with no flag at all says there is nothing to change', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--name', 'hook']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing to change');
    expect(result.err).toContain('--unset');
  });

  it('naming an unnamed subscriber still works with --name alone', async () => {
    writeFileSync(file, lines('subscribers:', '  ev:', '    - type: cli', '      command: echo'));
    const result = await run(['edit', 'ev', '--index', '0', '--name', 'named']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['ev'][0]).toEqual({ type: 'cli', name: 'named', command: 'echo' });
  });

  it('refuses a name another subscriber of the event has', async () => {
    writeFileSync(file, HTTP);
    const result = await run(['edit', 'ev', '--index', '1', '--name', 'hook', '--timeout', '5s']);
    expect(result.code).toBe(1);
    expect(result.err).toContain("'hook'");
    expect(result.err).toContain('index 0');
  });

  it('merges --set into the with of an action instead of replacing it', async () => {
    writeFileSync(file, lines('subscribers:', '  ev:', '    - type: action', '      name: relay', '      action: emit', '      retries: 3', '      with:', '        event: a.b', '        payload: { keep: k, text: old }'));
    const result = await run(['edit', 'ev', '--name', 'relay', '--set', 'payload.text=new']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['ev'][0]).toEqual({ type: 'action', name: 'relay', action: 'emit', retries: 3, with: { event: 'a.b', payload: { keep: 'k', text: 'new' } } });
  });
});

describe('R4b item 3 - an event key that can never match is refused by sub add', () => {
  it.each(['dep.pub*', 'on.*x', 'on..x', 'on.>.x', 'dep.**'])('refuses %s with the reason and writes nothing', async (event) => {
    const result = await run(['add', event, '--name', 'x', '--type', 'cli', '--command', 'echo']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('[fail]');
    expect(result.err).toContain(`"${event}"`);
    expect(() => readFileSync(file, 'utf-8')).toThrow();
  });

  it.each(['dep.>', 'on.*.x', 'plain.name', '>'])('accepts %s', async (event) => {
    const result = await run(['add', event, '--name', 'x', '--type', 'cli', '--command', 'echo']);
    expect(result.code, result.err).toBe(0);
  });
});

describe('R4b item 4 - flags are never ignored', () => {
  it.each([
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--retry', '3'], "unknown option '--retry'"],
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--timeout'], '--timeout needs a value'],
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--retries', '5abc'], '--retries must be a whole number'],
    [['add', 'ev', '--name', 'x', '--type', 'http', '--url', 'http://x', '--method', 'FETCH'], '--method must be one of'],
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--scope'], '--scope needs a value'],
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', '--scope', 'user'], '--scope must be global or project'],
    [['add', 'ev', '--name', 'x', '--type', 'cli', '--command', 'echo', 'hi'], "unexpected argument 'hi'"],
  ])('add %j fails with "%s" and writes nothing', async (args, expected) => {
    const result = await run(args as string[]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(expected);
    expect(() => readFileSync(file, 'utf-8')).toThrow();
  });

  it('edit and remove refuse an unknown option instead of ignoring it, and leave the file alone', async () => {
    writeFileSync(file, PLAIN);
    for (const args of [['edit', 'deploy.done', '--name', 'notify', '--timout', '5s'], ['remove', 'deploy.done', '--name', 'notify', '--force']]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err).toContain('unknown option');
      expect(readFileSync(file, 'utf-8')).toBe(PLAIN);
    }
  });

  it('list with --scope and no value is an error, not the global file', async () => {
    const result = await run(['list', '--scope']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--scope needs a value');
  });

  it('list warns about an unknown option and still lists', async () => {
    writeFileSync(file, PLAIN);
    const result = await run(['list', '--scope', 'global', '--jsno']);
    expect(result.code).toBe(0);
    expect(result.err).toContain("[warn]");
    expect(result.err).toContain("unknown option '--jsno'");
    expect(result.err).toContain("did you mean '--json'?");
  });

  it('--set payload.toString=x works (a key named like a member of Object.prototype)', async () => {
    const result = await run(['add', 'ev', '--name', 'x', '--type', 'action', '--action', 'emit', '--set', 'event=a.b', '--set', 'payload.toString=x']);
    expect(result.code, result.err).toBe(0);
    expect(readDoc().subscribers['ev'][0].with).toMatchObject({ event: 'a.b' });
    expect(Object.hasOwn(readDoc().subscribers['ev'][0].with.payload, 'toString')).toBe(true);
  });
});

describe('R4b item 5 and 6 - sub list shows the problem of a subscriber and uses one id format', () => {
  const BAD_ACTION = lines('subscribers:', '  ev:', '    - type: action', '      name: relay', '      action: nope', '    - type: cli', '      name: fine', '      command: echo');

  it('--scope: a [warn] per subscriber with a problem, exit 0, and the problem in --json', async () => {
    writeFileSync(file, BAD_ACTION);
    const text = await run(['list', '--scope', 'global']);
    expect(text.code).toBe(0);
    expect(text.err).toContain("[warn] subscriber relay (event 'ev') cannot run:");
    expect(text.err).toContain('unknown action "nope"');
    expect(text.err).not.toContain('subscriber fine');
    const json = await run(['list', '--scope', 'global', '--json']);
    const parsed = JSON.parse(json.out) as Array<{ subscriberId: string; problem?: string }>;
    expect(parsed.find((s) => s.subscriberId === 'relay')!.problem).toContain('nope');
    expect(parsed.find((s) => s.subscriberId === 'fine')!.problem).toBeUndefined();
  });

  it('the daemon answer: the problem it computed is warned and carried by --json', async () => {
    const listFromDaemon = (): Promise<never> =>
      Promise.resolve([
        { subscriberId: 'p1/relay', name: 'relay', event: 'ev', type: 'action', action: 'agent-wake', problem: "action 'agent-wake': to is required" },
        { subscriberId: 'p1/fine', name: 'fine', event: 'ev', type: 'cli', command: 'echo' },
      ] as never);
    const text = await run(['list'], { listFromDaemon });
    expect(text.code).toBe(0);
    expect(text.err).toContain("[warn] subscriber p1/relay (event 'ev') cannot run: action 'agent-wake': to is required");
    expect(text.err).not.toContain('subscriber p1/fine');
    const json = await run(['list', '--json'], { listFromDaemon });
    expect((JSON.parse(json.out) as Array<{ problem?: string }>)[0]!.problem).toContain('to is required');
  });

  it('--scope global: a name repeated under two events is qualified with its event, like the daemon does', async () => {
    writeFileSync(file, lines('subscribers:', '  a.b:', '    - type: cli', '      name: notify', '      command: echo', '  c.d:', '    - type: cli', '      name: notify', '      command: echo', '    - type: cli', '      name: solo', '      command: echo'));
    const json = await run(['list', '--scope', 'global', '--json']);
    expect((JSON.parse(json.out) as Array<{ subscriberId: string }>).map((s) => s.subscriberId)).toEqual(['notify@a.b', 'notify@c.d', 'solo']);
  });

  it('--scope project: the id carries the project id, like the daemon list and the history', async () => {
    const folder = join(dir, 'proj');
    mkdirSync(folder, { recursive: true });
    const project = await addProject(registryDir, { name: 'proj', path: folder });
    const projectFile = join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml');
    writeFileSync(projectFile, lines('subscribers:', '  ev:', '    - type: cli', '      name: mine', '      command: echo'));
    const json = await run(['list', '--scope', 'project', '--json'], { cwd: folder });
    expect(json.code, json.err).toBe(0);
    expect((JSON.parse(json.out) as Array<{ subscriberId: string }>)[0]!.subscriberId).toBe(`${project.id}/mine`);
  });
});

describe('sub help and usage', () => {
  it('prints the help for no sub-command and for --help', async () => {
    expect((await run([])).out).toBe('HELP\n');
    expect((await run(['--help'])).out).toBe('HELP\n');
  });

  it('refuses an unknown sub-command and a missing event', async () => {
    expect((await run(['nope'])).err).toContain('Unknown sub subcommand: nope');
    const missing = await run(['add']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Usage: queue sub add <event>');
  });
});

describe('queue sub add with an event name that cannot be a key', () => {
  it('__proto__ is refused with a message that names the event and says what to do, not a raw validation dump', async () => {
    const result = await run(['add', '__proto__', '--name', 'x', '--type', 'cli', '--command', 'echo']);
    expect(result.code).toBe(1);
    expect(result.err).toContain("'__proto__'");
    expect(result.err).toContain('Fix:');
    expect(result.err).not.toContain('"code"');
    expect(result.err).not.toContain('ZodError');
    expect(existsSync(file)).toBe(false);
  });
});

describe('queue sub list: the waits that are running', () => {
  const daemonList = (): Promise<never> => Promise.resolve([{ subscriberId: 'fine', name: 'fine', event: 'ev', type: 'cli', command: 'echo' }] as never);
  const waitingNow = (event: string | undefined): string => `\nWaiting now (1):\n  a.b ${event ?? '*'}\n`;

  it('on a terminal, after the subscribers, from the section the CLI gives', async () => {
    const asked: Array<string | undefined> = [];
    const text = await run(['list', 'ev'], { isTTY: true, listFromDaemon: daemonList, waitingNow: (event) => { asked.push(event); return waitingNow(event); } });
    expect(text.out).toBe('[ok] fine  cli  echo\n\nWaiting now (1):\n  a.b ev\n');
    expect(asked).toEqual(['ev']);
  });

  it('--json stays the bare array, and a pipe too', async () => {
    const waitingNowShouldNotRun = (): string => { throw new Error('the section is for the terminal form only'); };
    const json = await run(['list', '--json'], { isTTY: true, listFromDaemon: daemonList, waitingNow: waitingNowShouldNotRun });
    expect(JSON.parse(json.out)).toEqual([{ subscriberId: 'fine', name: 'fine', event: 'ev', type: 'cli', command: 'echo' }]);
    const piped = await run(['list'], { isTTY: false, listFromDaemon: daemonList, waitingNow: waitingNowShouldNotRun });
    expect(JSON.parse(piped.out)).toHaveLength(1);
  });

  it('--scope lists a file, not the running queue: no section', async () => {
    writeFileSync(file, lines('subscribers:', '  ev:', '    - type: cli', '      name: fine', '      command: echo'));
    const text = await run(['list', '--scope', 'global'], { isTTY: true, waitingNow: () => { throw new Error('no section for --scope'); } });
    expect(text.code).toBe(0);
    expect(text.out).not.toContain('Waiting now');
  });
});
