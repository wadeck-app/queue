import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { listSubscribers } from './subscribers.js';

let configDir: string;
let registryDir: string;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-subs-config-'));
  registryDir = mkdtempSync(join(tmpdir(), 'app-module-subs-registry-'));
  projectDir = mkdtempSync(join(tmpdir(), 'app-module-subs-project-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true });
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
