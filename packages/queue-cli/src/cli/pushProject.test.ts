import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, addPath } from '@wadeck-app/project-sdk';
import { parseProjectFlag, parseDirectionFlag, resolvePushProject, resolveProjectId, onlyProject } from './pushProject.js';

let registryDir: string;
let work: string;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'queue-push-registry-'));
  work = mkdtempSync(join(tmpdir(), 'queue-push-work-'));
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function folder(name: string): string {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
}

// Conformance with the project-sdk (extractProjectOption), the one place that knows how a CLI reads the project option: every row is a
// rule the SDK states; if one fails after an SDK update, the SDK changed, not queue.
describe('parseProjectFlag (conformance with the project-sdk option parser)', () => {
  it.each([
    ['--project <ref>, after the positional arguments', ['onFoo', '{}', '--project', 'app'], {}, { value: 'app', args: ['onFoo', '{}'] }],
    ['-p <ref>, before the positional arguments', ['-p', 'app', 'onFoo', '{}'], {}, { value: 'app', args: ['onFoo', '{}'] }],
    ['--project=<ref>', ['onFoo', '--project=app', '{}'], {}, { value: 'app', args: ['onFoo', '{}'] }],
    ['no option at all', ['onFoo', '{}'], {}, { args: ['onFoo', '{}'] }],
    ['the environment variable, when given', ['onFoo'], { QUEUE_PROJECT: 'app' }, { env: 'app', args: ['onFoo'] }],
    ['a blank environment variable counts as unset', ['onFoo'], { QUEUE_PROJECT: '   ' }, { args: ['onFoo'] }],
    ['the flag and the variable are both reported (the SDK decides which wins when it resolves)', ['-p', 'a'], { QUEUE_PROJECT: 'b' }, { value: 'a', env: 'b', args: [] }],
    ['nothing after -- is read', ['onFoo', '--', '--project', 'app'], {}, { args: ['onFoo', '--', '--project', 'app'] }],
  ])('%s', (_name, argv, env, expected) => {
    expect(parseProjectFlag(argv, env)).toEqual(expected);
  });

  it.each([
    ['a flag without value (last argument)', ['onFoo', '--project'], '--project needs a value'],
    ['a flag followed by another flag', ['--project', '--json'], '--project needs a value'],
    ['-p without value', ['-p'], '-p needs a value'],
    ['the flag given twice', ['-p', 'a', '--project', 'b'], 'twice'],
    ['the same flag repeated', ['--project=a', '--project=b'], 'twice'],
  ])('refuses %s, loudly, with what to do', (_name, argv, expected) => {
    const parsed = parseProjectFlag(argv);
    expect(parsed.error).toContain(expected);
    expect(parsed.value).toBeUndefined();
  });

  it('ignores the environment variable unless given the environment: a read command filters on the flag only', () => {
    expect(parseProjectFlag(['x'])).toEqual({ args: ['x'] });
  });
});

describe('parseDirectionFlag', () => {
  it('is absent without the flag: the daemon applies to-parents', () => {
    expect(parseDirectionFlag(['evt', '{}'])).toEqual({});
  });

  it('collects the repeated flag in the order given, once each', () => {
    expect(parseDirectionFlag(['--direction', 'to-parents', 'x', '--direction', 'to-children', '--direction', 'to-parents'])).toEqual({ value: ['to-parents', 'to-children'] });
  });

  it('refuses an unknown value, naming it and the accepted ones', () => {
    const parsed = parseDirectionFlag(['--direction', 'sideways']);
    expect(parsed.error).toContain('sideways');
    expect(parsed.error).toContain('to-parents');
    expect(parsed.error).toContain('to-children');
  });

  it('refuses a flag without a value instead of ignoring it', () => {
    expect(parseDirectionFlag(['--direction']).error).toContain('--direction needs a value');
    expect(parseDirectionFlag(['--direction', '--timeout', '5s']).error).toContain('--direction needs a value');
  });
});

describe('resolvePushProject', () => {
  it('names no project when neither the flag nor QUEUE_PROJECT is given: the daemon derives it from the working directory', () => {
    expect(resolvePushProject({ argv: [], cwd: work, registryDir, env: {} })).toEqual({ ok: true });
  });

  it('resolves a name, an alias or an id to the project id, and sends the registered path that contains the working directory', async () => {
    const main = folder('app');
    const second = folder('app-docs');
    const project = await addProject(registryDir, { name: 'app', path: main });
    await addPath(registryDir, project.id, second);
    const byFlag = resolvePushProject({ argv: ['--project', 'app'], cwd: join(second, 'sub'), registryDir, env: {} });
    expect(byFlag).toMatchObject({ ok: true, project: project.id });
    expect(byFlag.ok && byFlag.cwd?.replace(/\\/g, '/')).toBe(second.replace(/\\/g, '/'));
    expect(resolvePushProject({ argv: ['--project', project.id], cwd: work, registryDir, env: {} })).toMatchObject({ ok: true, project: project.id });
  });

  it('uses the main path when the caller is outside the project', async () => {
    const main = folder('app');
    await addProject(registryDir, { name: 'app', path: main });
    const result = resolvePushProject({ argv: ['--project', 'app'], cwd: work, registryDir, env: {} });
    expect(result.ok && result.cwd?.replace(/\\/g, '/')).toBe(main.replace(/\\/g, '/'));
  });

  it('QUEUE_PROJECT is the default project; the flag wins over it', async () => {
    const a = await addProject(registryDir, { name: 'alpha', path: folder('alpha') });
    const b = await addProject(registryDir, { name: 'beta', path: folder('beta') });
    expect(resolvePushProject({ argv: [], cwd: work, registryDir, env: { QUEUE_PROJECT: 'alpha' } })).toMatchObject({ ok: true, project: a.id });
    expect(resolvePushProject({ argv: ['--project', 'beta'], cwd: work, registryDir, env: { QUEUE_PROJECT: 'alpha' } })).toMatchObject({ ok: true, project: b.id });
  });

  it('refuses a project that does not exist, with the closest names and what to do, instead of pushing without it', async () => {
    await addProject(registryDir, { name: 'alpha', path: folder('alpha') });
    const result = resolvePushProject({ argv: ['--project', 'alpa'], cwd: work, registryDir, env: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('alpa');
    expect(!result.ok && result.message).toContain('alpha');
  });

  it('accepts a project without any path (virtual): the push names the project and sends no working directory (Decision #29)', async () => {
    const project = await addProject(registryDir, { name: 'virtual' });
    const result = resolvePushProject({ argv: ['--project', 'virtual'], cwd: work, registryDir, env: {} });
    expect(result).toEqual({ ok: true, project: project.id });
  });

  it('refuses a project option that is malformed (missing value, given twice) before looking at the registry', () => {
    expect(resolvePushProject({ argv: ['--project'], cwd: work, registryDir, env: {} }).ok).toBe(false);
    expect(resolvePushProject({ argv: ['-p', 'a', '-p', 'b'], cwd: work, registryDir, env: {} }).ok).toBe(false);
  });

  it('names where a wrong QUEUE_PROJECT comes from', () => {
    const result = resolvePushProject({ argv: [], cwd: work, registryDir, env: { QUEUE_PROJECT: 'nope' } });
    expect(!result.ok && result.message).toContain('QUEUE_PROJECT');
  });
});

describe('resolveProjectId (the --project filter of a read command)', () => {
  it('turns a name, an alias or an id into the id', async () => {
    const project = await addProject(registryDir, { name: 'app', path: folder('app') });
    expect(resolveProjectId('app', registryDir)).toEqual({ ok: true, id: project.id });
    expect(resolveProjectId(project.id, registryDir)).toEqual({ ok: true, id: project.id });
  });

  it('refuses a reference that matches nothing, with the closest names: a filter on nothing would list nothing and look like an empty history', async () => {
    await addProject(registryDir, { name: 'alpha', path: folder('alpha') });
    const result = resolveProjectId('alpa', registryDir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('alpha');
  });

  it('needs no path: a project without any (virtual) is a valid filter', async () => {
    const project = await addProject(registryDir, { name: 'virtual' });
    expect(resolveProjectId('virtual', registryDir)).toEqual({ ok: true, id: project.id });
  });
});

describe('onlyProject', () => {
  const entries = [{ id: 'a', meta: { projectId: '569c412d' } }, { id: 'b', meta: { projectId: 'deadbeef' } }, { id: 'c', meta: {} }];

  it('keeps the entries of that project', () => {
    expect(onlyProject(entries, '569c412d').map((e) => e.id)).toEqual(['a']);
  });

  it('keeps all of them without a project', () => {
    expect(onlyProject(entries, undefined)).toHaveLength(3);
  });
});
