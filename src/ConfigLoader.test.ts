import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from './ConfigLoader.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSubscribersYml(dir: string, content: string): string {
  const queueDir = join(dir, '.queue');
  mkdirSync(queueDir, { recursive: true });
  const filePath = join(queueDir, 'subscribers.yml');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('ConfigLoader - cwd resolution', () => {
  let projectDir: string;
  let globalDir: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    projectDir = makeTmpDir();
    globalDir = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('default cwd = project root (parent of .queue/) when no cwd configured', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cwd).toBe(projectDir);
  });

  it('global cwd is resolved relative to subscribers.yml file directory', () => {
    writeSubscribersYml(projectDir, `
cwd: ..
subscribers:
  onTest:
    - type: cli
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    // ".." relative to .queue/ = projectDir's parent
    expect(subs[0]!.cwd).toBe(resolve(join(projectDir, '.queue'), '..'));
  });

  it('absolute global cwd is used as-is', () => {
    const forwardSlashDir = projectDir.replace(/\\/g, '/');
    writeSubscribersYml(projectDir, `
cwd: ${forwardSlashDir}
subscribers:
  onTest:
    - type: cli
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    // normalize both sides to handle forward/back slash differences on Windows
    expect(normalize(subs[0]!.cwd!)).toBe(normalize(projectDir));
  });

  it('per-event cwd overrides global cwd (object form)', () => {
    const eventDir = join(projectDir, 'flows');
    mkdirSync(eventDir, { recursive: true });
    writeSubscribersYml(projectDir, `
cwd: ./
subscribers:
  onTest:
    cwd: ./flows
    commands:
      - type: cli
        command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.cwd).toBe(resolve(join(projectDir, '.queue'), './flows'));
  });

  it('per-subscriber cwd overrides event cwd', () => {
    const subDir = join(projectDir, 'special');
    mkdirSync(subDir, { recursive: true });
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    cwd: ./flows
    commands:
      - type: cli
        command: echo hi
        cwd: ./special
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.cwd).toBe(resolve(join(projectDir, '.queue'), './special'));
  });

  it('array form (existing format) still works and uses default cwd', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      command: echo legacy
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cwd).toBe(projectDir);
  });

  it('global config dir without .queue uses dirname as default cwd', () => {
    const globalFile = join(globalDir, 'subscribers.yml');
    writeFileSync(globalFile, `
subscribers:
  onTest:
    - type: cli
      command: echo global
`, 'utf-8');
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs).toHaveLength(1);
    // globalDir is not inside .queue, so default = globalDir itself
    expect(subs[0]!.cwd).toBe(globalDir);
  });
});

describe('ConfigLoader - env resolution', () => {
  let projectDir: string;
  let globalDir: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    projectDir = makeTmpDir();
    globalDir = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('no env configured → env is undefined', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.env).toBeUndefined();
  });

  it('global env only', () => {
    writeSubscribersYml(projectDir, `
env:
  GLOBAL_VAR: global_value
subscribers:
  onTest:
    - type: cli
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.env).toEqual({ GLOBAL_VAR: 'global_value' });
  });

  it('event env merged on top of global env', () => {
    writeSubscribersYml(projectDir, `
env:
  GLOBAL_VAR: global
  SHARED: from-global
subscribers:
  onTest:
    env:
      EVENT_VAR: event
      SHARED: from-event
    commands:
      - type: cli
        command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.env).toEqual({
      GLOBAL_VAR: 'global',
      SHARED: 'from-event',
      EVENT_VAR: 'event',
    });
  });

  it('subscriber env merged on top of global+event env', () => {
    writeSubscribersYml(projectDir, `
env:
  GLOBAL_VAR: global
subscribers:
  onTest:
    env:
      EVENT_VAR: event
    commands:
      - type: cli
        command: echo hi
        env:
          SUB_VAR: sub
          GLOBAL_VAR: overridden
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.env).toEqual({
      GLOBAL_VAR: 'overridden',
      EVENT_VAR: 'event',
      SUB_VAR: 'sub',
    });
  });

  it('subscriber-only env (no global or event env)', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      command: echo hi
      env:
        ONLY_SUB: value
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs[0]!.env).toEqual({ ONLY_SUB: 'value' });
  });

  it('multiple subscribers in same event each get correct env', () => {
    writeSubscribersYml(projectDir, `
env:
  GLOBAL: g
subscribers:
  onTest:
    env:
      EVENT: e
    commands:
      - type: cli
        command: echo first
      - type: cli
        command: echo second
        env:
          SUB_ONLY: s
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs).toHaveLength(2);
    expect(subs[0]!.env).toEqual({ GLOBAL: 'g', EVENT: 'e' });
    expect(subs[1]!.env).toEqual({ GLOBAL: 'g', EVENT: 'e', SUB_ONLY: 's' });
  });
});

describe('ConfigLoader - schema validation', () => {
  let projectDir: string;
  let globalDir: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    projectDir = makeTmpDir();
    globalDir = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('invalid YAML throws with actionable message', () => {
    const queueDir = join(projectDir, '.queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, 'subscribers.yml'), 'invalid: [yaml: {', 'utf-8');
    expect(() => loader.getSubscribers('onTest', projectDir)).toThrow(/Failed to parse YAML/);
  });

  it('invalid schema throws with actionable message', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: unknown_type
      command: echo hi
`);
    expect(() => loader.getSubscribers('onTest', projectDir)).toThrow(/Invalid subscribers\.yml/);
  });
});

describe('ConfigLoader - global + project merge', () => {
  let projectDir: string;
  let globalDir: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    projectDir = makeTmpDir();
    globalDir = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('global and project subscribers are both returned', () => {
    writeFileSync(join(globalDir, 'subscribers.yml'), `
subscribers:
  onTest:
    - type: cli
      command: echo global
`, 'utf-8');
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      command: echo project
`);
    const subs = loader.getSubscribers('onTest', projectDir);
    expect(subs).toHaveLength(2);
    expect(subs[0]!.command).toBe('echo global');
    expect(subs[1]!.command).toBe('echo project');
  });
});
