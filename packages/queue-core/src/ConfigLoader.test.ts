import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader, type ProjectConfigSource } from './ConfigLoader.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEST_PROJECT_ID = '64f4ae91';
const NL = String.fromCharCode(10);

/** Writes the subscribers.yml of the project at `dir` in its config folder (`<dir>/.config`), as the registry would hold it. */
function writeSubscribersYml(dir: string, content: string): string {
  const configDir = join(dir, '.config');
  mkdirSync(configDir, { recursive: true });
  const filePath = join(configDir, 'subscribers.yml');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Writes the old per-project file, <dir>/.queue/subscribers.yml, that is no longer read. */
function writeLegacySubscribersYml(dir: string, content: string): string {
  const queueDir = join(dir, '.queue');
  mkdirSync(queueDir, { recursive: true });
  const filePath = join(queueDir, 'subscribers.yml');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** The registered project whose folder is `dir` and whose config folder is `<dir>/.config`. */
function sourceOf(dir: string): ProjectConfigSource {
  return { projectId: TEST_PROJECT_ID, layers: [{ dir: join(dir, '.config'), projectId: TEST_PROJECT_ID, projectName: 'app', folder: dir }] };
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
      name: a
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cwd).toBe(projectDir);
  });

  it('global cwd is resolved relative to the project folder', () => {
    writeSubscribersYml(projectDir, `
cwd: ..
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    // ".." relative to the project folder = its parent
    expect(subs[0]!.cwd).toBe(resolve(projectDir, '..'));
  });

  it('absolute global cwd is used as-is', () => {
    const forwardSlashDir = projectDir.replace(/\\/g, '/');
    writeSubscribersYml(projectDir, `
cwd: ${forwardSlashDir}
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
        name: a
        command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs[0]!.cwd).toBe(resolve(projectDir, './flows'));
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
        name: a
        command: echo hi
        cwd: ./special
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs[0]!.cwd).toBe(resolve(projectDir, './special'));
  });

  it('array form (existing format) still works and uses default cwd', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo legacy
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cwd).toBe(projectDir);
  });

  it('global config dir without .queue uses dirname as default cwd', () => {
    const globalFile = join(globalDir, 'subscribers.yml');
    writeFileSync(globalFile, `
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo global
`, 'utf-8');
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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

  it('no env configured: env is undefined', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs[0]!.env).toBeUndefined();
  });

  it('global env only', () => {
    writeSubscribersYml(projectDir, `
env:
  GLOBAL_VAR: global_value
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
        name: a
        command: echo hi
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
        name: a
        command: echo hi
        env:
          SUB_VAR: sub
          GLOBAL_VAR: overridden
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
      name: a
      command: echo hi
      env:
        ONLY_SUB: value
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
        name: a
        command: echo first
      - type: cli
        name: b
        command: echo second
        env:
          SUB_ONLY: s
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
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
    writeSubscribersYml(projectDir, 'invalid: [yaml: {');
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/Failed to parse YAML/);
  });

  it('invalid schema throws with actionable message', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: unknown_type
      command: echo hi
`);
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/Invalid subscribers\.yml/);
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
      name: a
      command: echo global
`, 'utf-8');
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      name: b
      command: echo project
`);
    const subs = loader.getSubscribers('onTest', projectDir, sourceOf(projectDir));
    expect(subs).toHaveLength(2);
    expect(subs[0]!.command).toBe('echo global');
    expect(subs[1]!.command).toBe('echo project');
  });
});

describe('ConfigLoader - subscriber validation', () => {
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

  it("cli subscriber without command is rejected at load time, naming event and index", () => {
    const filePath = writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo ok
    - type: cli
      name: b
      when: payload.exitCode=1
`);
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/subscriber 'onTest' index 1/);
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/type 'cli' requires a 'command' field/);
    // the message must point at the offending file and give a fix
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(filePath);
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/queue sub edit onTest --index 1/);
  });

  it('http subscriber without url is rejected at load time', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: http
      name: a
      method: POST
`);
    expect(() => loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toThrow(/type 'http' requires a 'url' field/);
  });

  it('valid subscribers still load', () => {
    writeSubscribersYml(projectDir, `
subscribers:
  onTest:
    - type: cli
      name: a
      command: echo ok
    - type: http
      name: b
      url: http://localhost:1234/hook
`);
    expect(loader.getSubscribers('onTest', projectDir, sourceOf(projectDir))).toHaveLength(2);
  });
});

describe('ConfigLoader - subscriber ids', () => {
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

  it('a global and a project subscriber with the same name on the same event get distinct ids (the daemon keys its WAL entries by id)', () => {
    writeFileSync(join(globalDir, 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo global\n      name: notify\n', 'utf-8');
    writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo project\n      name: notify\n');
    const ids = loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir)).map((s) => s.subscriberId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });


  it('uses the name as id: <name> in the global file, <project>/<name> in a project file', () => {
    writeFileSync(join(globalDir, 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo g\n      name: notify\n', 'utf-8');
    writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo p\n      name: notify\n');
    const [global, project] = loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir));
    expect(global).toMatchObject({ subscriberId: 'notify', name: 'notify' });
    expect(project).toMatchObject({ subscriberId: `${TEST_PROJECT_ID}/notify`, name: 'notify' });
  });

  it('a name survives a reorder of the list, a position does not', () => {
    writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: a\n    - type: cli\n      command: echo b\n      name: b\n');
    const before = loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir)).find((s) => s.name === 'b')!.subscriberId;
    writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo b\n      name: b\n    - type: cli\n      command: echo a\n      name: a\n');
    const after = loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir)).find((s) => s.name === 'b')!.subscriberId;
    expect(after).toBe(before);
  });

  it('refuses a duplicate name on the same event of a file, naming the file and the fix', () => {
    const file = writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: same\n    - type: cli\n      command: echo b\n      name: same\n');
    let message = '';
    try {
      loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("'same'");
    expect(message).toContain('onFoo');
    expect(message).toContain(file);
    expect(message).toContain('Fix:');
  });

  it.each(['Notify', 'has space', '-lead', 'a/b', ''])('refuses the invalid name %j with the accepted format', (name) => {
    writeSubscribersYml(projectDir, `subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: "${name}"\n`);
    expect(() => loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir))).toThrow('[a-z0-9][a-z0-9._-]*');
  });
});

describe('ConfigLoader - unnamed subscribers', () => {
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

  it('says which file a subscriber comes from and whether it is global or project', () => {
    writeFileSync(join(globalDir, 'subscribers.yml'), 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo g\n      name: g\n', 'utf-8');
    const projectFile = writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo p\n      name: p\n');
    const [global, project] = loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir));
    expect(global).toMatchObject({ scope: 'global', file: join(globalDir, 'subscribers.yml') });
    expect(project).toMatchObject({ scope: 'project', file: projectFile });
  });


  it('refuses an unnamed project subscriber, naming the file, the event, the index and the exact command that names it', () => {
    const file = writeSubscribersYml(projectDir, 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo a\n      name: a\n    - type: cli\n      command: echo p\n');
    let message = '';
    try {
      loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Subscriber 'onFoo' index 1");
    expect(message).toContain(file);
    expect(message).toContain('has no name');
    expect(message).toContain('queue sub edit onFoo --index 1 --name <name> --scope project');
  });

  it('refuses an unnamed global subscriber, naming the file, the event, the index and the fix without a scope (the default scope of queue sub)', () => {
    const file = join(globalDir, 'subscribers.yml');
    writeFileSync(file, 'subscribers:\n  onFoo:\n    - type: http\n      url: http://localhost/x\n', 'utf-8');
    let message = '';
    try {
      loader.getSubscribers('onFoo', projectDir, sourceOf(projectDir));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Subscriber 'onFoo' index 0");
    expect(message).toContain(file);
    expect(message).toContain('queue sub edit onFoo --index 0 --name <name>');
    expect(message).not.toContain('--scope');
  });
});

describe('ConfigLoader - subscribers kept in the config folder of a registered project', () => {
  let projectDir: string;
  let globalDir: string;
  let configRoot: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    projectDir = makeTmpDir();
    globalDir = makeTmpDir();
    configRoot = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  });

  /** A config folder of the registry with this subscribers.yml in it. */
  function layerDir(name: string, yml: string | null): string {
    const dir = join(configRoot, name);
    mkdirSync(dir, { recursive: true });
    if (yml !== null) {
      writeFileSync(join(dir, 'subscribers.yml'), yml, 'utf-8');
    }
    return dir;
  }

  const FOO = (command: string, name = 'n'): string => `subscribers:\n  onFoo:\n    - type: cli\n      command: ${command}\n      name: ${name}\n`;

  it('reads the file of the project, identifies its subscribers by the project id, and runs them from the project folder', () => {
    const dir = layerDir('64f4ae91', FOO('echo reg'));
    const [sub] = loader.getSubscribers('onFoo', projectDir, { projectId: '64f4ae91', layers: [{ dir, projectId: '64f4ae91', projectName: 'app', folder: projectDir }] });
    expect(sub).toMatchObject({ subscriberId: '64f4ae91/n', command: 'echo reg', scope: 'project', via: 'registry', file: join(dir, 'subscribers.yml'), cwd: projectDir });
  });

  it('resolves a relative cwd of the file from the project folder, not from the config folder', () => {
    const dir = layerDir('64f4ae91', 'subscribers:\n  onFoo:\n    - type: cli\n      command: echo x\n      name: n\n      cwd: tools\n');
    const [sub] = loader.getSubscribers('onFoo', projectDir, { projectId: '64f4ae91', layers: [{ dir, projectId: '64f4ae91', projectName: 'app', folder: projectDir }] });
    expect(sub!.cwd).toBe(resolve(projectDir, 'tools'));
  });

  it('applies the subscribers of the parent projects too, root first, each identified by the project that defines it', () => {
    const parent = layerDir('aaaaaaaa', FOO('echo parent', 'p'));
    const child = layerDir('bbbbbbbb', FOO('echo child', 'c'));
    const subs = loader.getSubscribers('onFoo', projectDir, {
      projectId: 'bbbbbbbb',
      layers: [
        { dir: parent, projectId: 'aaaaaaaa', projectName: 'parent', folder: join(projectDir, 'parent') },
        { dir: child, projectId: 'bbbbbbbb', projectName: 'child', folder: projectDir },
      ],
    });
    expect(subs.map((sub) => [sub.subscriberId, sub.command])).toEqual([
      ['aaaaaaaa/p', 'echo parent'],
      ['bbbbbbbb/c', 'echo child'],
    ]);
  });

  it('runs each subscriber from the main folder of the project that owns its file, not from the folder of the emitter', () => {
    const parent = layerDir('aaaaaaaa', FOO('echo parent', 'p'));
    const child = layerDir('bbbbbbbb', FOO('echo child', 'c'));
    const parentFolder = join(projectDir, 'parent');
    const subs = loader.getSubscribers('onFoo', projectDir, {
      projectId: 'bbbbbbbb',
      layers: [
        { dir: parent, projectId: 'aaaaaaaa', projectName: 'parent', folder: parentFolder },
        { dir: child, projectId: 'bbbbbbbb', projectName: 'child', folder: projectDir },
      ],
    });
    expect(subs.map((sub) => sub.cwd)).toEqual([parentFolder, projectDir]);
  });

  it('a subscriber of a virtual project (no folder) with no cwd of its own cannot run: it says so, naming the project and the fix', () => {
    const dir = layerDir('cccccccc', FOO('echo virtual', 'v'));
    const [sub] = loader.getSubscribers('onFoo', projectDir, { projectId: 'cccccccc', layers: [{ dir, projectId: 'cccccccc', projectName: 'virtual-app' }] });
    expect(sub!.cwdProblem).toContain("'virtual-app'");
    expect(sub!.cwdProblem).toContain('cwd');
  });

  it('a subscriber of a virtual project that gives an absolute cwd, or that is an http call, has no problem', () => {
    const yml = 'subscribers:' + NL + '  onFoo:' + NL + '    - type: cli' + NL + '      name: abs' + NL + '      command: echo x' + NL + '      cwd: ' + projectDir.replace(/\\/g, '/') + NL + '    - type: http' + NL + '      name: hook' + NL + '      url: http://localhost/x' + NL;
    const dir = layerDir('cccccccc', yml);
    const subs = loader.getSubscribers('onFoo', projectDir, { projectId: 'cccccccc', layers: [{ dir, projectId: 'cccccccc', projectName: 'virtual-app' }] });
    expect(subs.map((sub) => sub.cwdProblem)).toEqual([undefined, undefined]);
    // an absolute cwd is used as written (forward slashes)
    expect(subs[0]!.cwd).toBe(projectDir.replace(/\\/g, '/'));
  });

  it('a relative cwd in the file of a virtual project is a problem too: there is no folder to resolve it against', () => {
    const yml = 'subscribers:' + NL + '  onFoo:' + NL + '    - type: cli' + NL + '      name: rel' + NL + '      command: echo x' + NL + '      cwd: tools' + NL;
    const dir = layerDir('cccccccc', yml);
    const [sub] = loader.getSubscribers('onFoo', projectDir, { projectId: 'cccccccc', layers: [{ dir, projectId: 'cccccccc', projectName: 'virtual-app' }] });
    expect(sub!.cwdProblem).toContain("'virtual-app'");
  });

  it('does not read the .queue/subscribers.yml found above the working directory once the project has a file of its own', () => {
    writeLegacySubscribersYml(projectDir, FOO('echo walk-up', 'old'));
    const dir = layerDir('64f4ae91', FOO('echo reg'));
    const subs = loader.getSubscribers('onFoo', projectDir, { projectId: '64f4ae91', layers: [{ dir, projectId: '64f4ae91', projectName: 'app', folder: projectDir }] });
    expect(subs.map((sub) => sub.command)).toEqual(['echo reg']);
  });

  it('refuses the .queue/subscribers.yml found above when the project has no file yet, naming the old file and the file to move it to', () => {
    const file = writeLegacySubscribersYml(projectDir, FOO('echo walk-up', 'old'));
    const dir = layerDir('64f4ae91', null);
    let message = '';
    try {
      loader.getSubscribers('onFoo', projectDir, { projectId: '64f4ae91', layers: [{ dir, projectId: '64f4ae91', projectName: 'app', folder: projectDir }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain(join(dir, 'subscribers.yml'));
    expect(message).toContain('Fix:');
  });

  it('refuses the .queue/subscribers.yml found above when the working directory is in no registered project, and says to register the project', () => {
    const file = writeLegacySubscribersYml(projectDir, FOO('echo walk-up', 'old'));
    let message = '';
    try {
      loader.getSubscribers('onFoo', projectDir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain(`project add "${projectDir}"`);
  });

  it('refuses a key that is not one of a subscribers file, naming the file and the key, instead of ignoring it', () => {
    const dir = layerDir('64f4ae91', 'subscribers: {}\nsubscriber:\n  onFoo: []\n');
    expect(() => loader.getSubscribers('onFoo', projectDir, { projectId: '64f4ae91', layers: [{ dir, projectId: '64f4ae91', projectName: 'app', folder: projectDir }] })).toThrow(/subscribers\.yml[\s\S]*subscriber/);
  });

  it('without a project and without an old file, only the global file applies', () => {
    writeFileSync(join(globalDir, 'subscribers.yml'), FOO('echo global', 'g'), 'utf-8');
    expect(loader.getSubscribers('onFoo', projectDir).map((sub) => sub.subscriberId)).toEqual(['g']);
  });
});

describe('ConfigLoader - command templates ({{ }} runs without a shell)', () => {
  let globalDir: string;
  let loader: ConfigLoader;

  beforeEach(() => {
    globalDir = makeTmpDir();
    loader = new ConfigLoader(globalDir);
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  function load(command: string) {
    writeFileSync(join(globalDir, 'subscribers.yml'), `subscribers:\n  onFoo:\n    - type: cli\n      name: notify\n      command: ${JSON.stringify(command)}\n`, 'utf-8');
    return loader.getSubscribers('onFoo', undefined);
  }

  it('accepts a command with placeholders and quoted arguments', () => {
    expect(load('node script.js --title "{{ payload.title }}" --id {{ id }}')).toHaveLength(1);
  });

  it('leaves a command without placeholders alone, shell syntax included (trusted config)', () => {
    expect(load('echo a | sort > out.txt && echo $HOME')).toHaveLength(1);
  });

  it.each([
    ['a pipe', 'cat {{ x }} | sort', "'|'"],
    ['&&', 'build {{ x }} && deploy', "'&'"],
    ['a semicolon', 'echo {{ x }}; rm -rf y', "';'"],
    ['a redirection', 'echo {{ x }} > out.txt', "'>'"],
    ['a backtick', 'echo {{ x }} `date`', '`'],
    ['$( )', 'echo {{ x }} $(date)', '$('],
    ['%VAR%', 'echo {{ x }} %PATH%', '%PATH%'],
    ['$VAR', 'echo {{ x }} $HOME', '$H'],
  ])('rejects %s next to a placeholder, naming the subscriber, the event and the fix', (_label, command, shown) => {
    let message = '';
    try {
      load(command);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("subscriber 'onFoo' index 0");
    expect(message).toContain(shown);
    expect(message).toContain('stdin');
    expect(message).toContain('Fix:');
  });

  it('accepts the same characters in single quotes (passed literally)', () => {
    expect(load("echo {{ x }} '| & ; > $HOME `date`'")).toHaveLength(1);
  });

  it('rejects an unterminated quote', () => {
    expect(() => load('echo "{{ x }}')).toThrow(/unterminated double quote/);
  });

  it('rejects a placeholder in the program position', () => {
    expect(() => load('{{ program }} --flag')).toThrow(/program position/);
  });
});
