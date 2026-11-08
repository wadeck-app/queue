import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { InvalidQueryError } from './errors.js';
import { listSubscribers } from './subscribers.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

let configDir: string;
let registryDir: string;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  configDir = makeTempDir('app-module-subs-config-');
  registryDir = makeTempDir('app-module-subs-registry-');
  projectDir = makeTempDir('app-module-subs-project-');
});

afterEach(() => {
  removeTempDir(configDir);
  removeTempDir(registryDir);
  removeTempDir(projectDir);
});

/** Registers the project folder and keeps this subscribers.yml in the config folder of the project. */
async function writeProjectSubscribers(yml: string): Promise<void> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  projectId = project.id;
  writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
}

describe('listSubscribers (reads subscribers.yml itself, no daemon needed)', () => {
  it('lists the resolved subscribers of the project', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    const result = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subscriberId: `${projectId}/a`, name: 'a', event: 'onFoo', type: 'cli', command: 'echo foo' });
  });

  it('filters to one event', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n  onBar:\n    - type: cli\n      name: b\n      command: echo bar\n');
    expect(listSubscribers(configDir, projectDir, 'onBar', registryDir).map(s => s.event)).toEqual(['onBar']);
  });

  it('masks the values of headers and env (tokens) but keeps their names', async () => {
    await writeProjectSubscribers(
      'subscribers:\n  onFoo:\n    - type: http\n      name: a\n      url: https://example.test/hook\n      headers:\n        Authorization: Bearer secret-token\n      env:\n        API_KEY: secret-key\n',
    );
    const [subscriber] = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(subscriber?.headers).toEqual({ Authorization: '***' });
    expect(subscriber?.env).toEqual({ API_KEY: '***' });
    expect(JSON.stringify(subscriber)).not.toContain('secret');
  });

  it('lists an action subscriber and masks every value of its with block, whatever the type, but keeps the keys', async () => {
    await writeProjectSubscribers(
      [
        'subscribers:',
        '  onFoo:',
        '    - type: action',
        '      name: wake',
        '      action: emit',
        '      with:',
        '        event: agent.message',
        '        payload:',
        '          to: project:secret-folder',
        '          text: "token abc123"',
        '          n: 42',
        '',
      ].join('\n'),
    );
    const [subscriber] = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(subscriber).toMatchObject({ type: 'action', action: 'emit', name: 'wake' });
    expect(subscriber?.with).toEqual({ event: '***', payload: '***' });
    expect(JSON.stringify(subscriber)).not.toContain('abc123');
    expect(JSON.stringify(subscriber)).not.toContain('secret-folder');
    expect(subscriber?.command).toBeUndefined();
    expect(subscriber?.url).toBeUndefined();
  });

  it('carries the problem of a subscriber that cannot run (a command of a virtual parent project has no folder), and none for a healthy one', async () => {
    const ghost = await addProject(registryDir, { name: 'ghost' });
    writeFileSync(join(projectToolDir(registryDir, ghost.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), ['subscribers:', '  onFoo:', '    - type: cli', '      name: lost', '      command: echo lost', '    - type: http', '      name: fine', '      url: http://example.test/hook', ''].join('\n'));
    await addProject(registryDir, { name: 'app', path: projectDir, parent: 'ghost' });
    const listed = listSubscribers(configDir, projectDir, undefined, registryDir);
    const lost = listed.find((s) => s.name === 'lost');
    expect(lost?.problem).toContain('virtual project');
    expect(lost?.problem).toContain('Fix:');
    expect(listed.find((s) => s.name === 'fine')?.problem).toBeUndefined();
  });

  it('has no headers or env in the answer when the subscriber has none', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    const [subscriber] = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(subscriber?.headers).toBeUndefined();
    expect(subscriber?.env).toBeUndefined();
  });

  it('throws on an invalid subscribers.yml instead of answering with an empty list', async () => {
    await writeProjectSubscribers('subscribers: [broken\n');
    expect(() => listSubscribers(configDir, projectDir, undefined, registryDir)).toThrow();
  });
});

describe('listSubscribers: names', () => {
  it('lists the name of each subscriber', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: notify\n    - type: cli\n      command: echo b\n      name: audit\n');
    const result = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(result.map((s) => s.name)).toEqual(['notify', 'audit']);
  });

  it('throws on an unnamed subscriber, naming the event, the index and the fix, instead of listing it as "unnamed"', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: notify\n    - type: cli\n      command: echo b\n');
    expect(() => listSubscribers(configDir, projectDir, undefined, registryDir)).toThrow(/Subscriber 'onFoo' index 1.*has no name[\s\S]*queue sub edit onFoo --index 1 --name <name> --scope project/);
  });
});

describe('listSubscribers: secrets in url and command', () => {
  it('masks the secret part of a webhook url and of a curl command, keeps the rest readable', async () => {
    await writeProjectSubscribers(
      [
        'subscribers:',
        '  onFoo:',
        '    - type: http',
        '      name: hook',
        '      url: https://hooks.slack.com/services/T000/B000/SECRETPATH',
        '    - type: cli',
        '      name: call',
        "      command: 'curl -H \"Authorization: Bearer secret-bearer\" https://example.test/x'",
        '',
      ].join('\n'),
    );
    const listed = listSubscribers(configDir, projectDir, undefined, registryDir);
    expect(listed.find((s) => s.name === 'hook')?.url).toBe('https://hooks.slack.com/services/***');
    expect(listed.find((s) => s.name === 'call')?.command).toBe('curl -H "Authorization: ***" https://example.test/x');
    expect(JSON.stringify(listed)).not.toContain('SECRETPATH');
    expect(JSON.stringify(listed)).not.toContain('secret-bearer');
  });
});

describe('listSubscribers: the working directory', () => {
  it('reads the daemon working directory when none is given', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    expect(() => listSubscribers(configDir, undefined, undefined, registryDir)).not.toThrow();
  });

  it('accepts a folder inside a registered project', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    const sub = join(projectDir, 'sub', 'dir');
    expect(listSubscribers(configDir, sub, undefined, registryDir).map((s) => s.name)).toEqual(['a']);
  });

  it('refuses a folder outside every registered project with the registered paths as the fix, and reads nothing there', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    const other = makeTempDir('app-module-subs-other-');
    try {
      mkdirSync(join(other, '.queue'));
      writeFileSync(join(other, '.queue', 'subscribers.yml'), 'subscribers: [broken\n');
      expect(() => listSubscribers(configDir, other, undefined, registryDir)).toThrow(InvalidQueryError);
      expect(() => listSubscribers(configDir, other, undefined, registryDir)).toThrow(/not inside a registered project[\s\S]*queue project list/);
    } finally {
      removeTempDir(other);
    }
  });

  it('refuses a sibling folder that merely shares the prefix of a registered path', async () => {
    await writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      name: a\n      command: echo foo\n');
    expect(() => listSubscribers(configDir, `${projectDir}-evil`, undefined, registryDir)).toThrow(InvalidQueryError);
  });
});
