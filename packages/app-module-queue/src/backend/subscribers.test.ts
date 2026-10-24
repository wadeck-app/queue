import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSubscribers } from './subscribers.js';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-subs-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'app-module-subs-project-'));
  mkdirSync(join(projectDir, '.queue'), { recursive: true });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeProjectSubscribers(yml: string): void {
  writeFileSync(join(projectDir, '.queue', 'subscribers.yml'), yml);
}

describe('listSubscribers (reads subscribers.yml itself, no daemon needed)', () => {
  it('lists the resolved subscribers of the project', () => {
    writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo foo\n');
    const result = listSubscribers(configDir, projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subscriberId: `${basename(projectDir)}/onFoo[0]`, legacyId: 'onFoo[0]', event: 'onFoo', type: 'cli', command: 'echo foo' });
  });

  it('filters to one event', () => {
    writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo foo\n  onBar:\n    - type: cli\n      command: echo bar\n');
    expect(listSubscribers(configDir, projectDir, 'onBar').map(s => s.event)).toEqual(['onBar']);
  });

  it('masks the values of headers and env (tokens) but keeps their names', () => {
    writeProjectSubscribers(
      'subscribers:\n  onFoo:\n    - type: http\n      url: https://example.test/hook\n      headers:\n        Authorization: Bearer secret-token\n      env:\n        API_KEY: secret-key\n',
    );
    const [subscriber] = listSubscribers(configDir, projectDir);
    expect(subscriber?.headers).toEqual({ Authorization: '***' });
    expect(subscriber?.env).toEqual({ API_KEY: '***' });
    expect(JSON.stringify(subscriber)).not.toContain('secret');
  });

  it('has no headers or env in the answer when the subscriber has none', () => {
    writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo foo\n');
    const [subscriber] = listSubscribers(configDir, projectDir);
    expect(subscriber?.headers).toBeUndefined();
    expect(subscriber?.env).toBeUndefined();
  });

  it('throws on an invalid subscribers.yml instead of answering with an empty list', () => {
    writeProjectSubscribers('subscribers: [broken\n');
    expect(() => listSubscribers(configDir, projectDir)).toThrow();
  });
});

describe('listSubscribers: names', () => {
  it('shows the name, or "unnamed" as a nudge to give one (queue sub edit <event> --index <N> --name <name>)', () => {
    writeProjectSubscribers('subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: notify\n    - type: cli\n      command: echo b\n');
    const result = listSubscribers(configDir, projectDir);
    expect(result.map((s) => s.nameText)).toEqual(['notify', 'unnamed']);
  });
});
