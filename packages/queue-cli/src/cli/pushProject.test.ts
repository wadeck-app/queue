import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, addPath } from '@wadeck-app/project-sdk';
import { parseProjectFlag, resolvePushProject, resolveProjectId, onlyProject } from './pushProject.js';

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

describe('parseProjectFlag', () => {
  it('reads --project and -p, anywhere among the arguments', () => {
    expect(parseProjectFlag(['onFoo', '{}', '--project', 'app'])).toEqual({ value: 'app' });
    expect(parseProjectFlag(['-p', 'app', 'onFoo', '{}'])).toEqual({ value: 'app' });
  });

  it('is absent without the flag', () => {
    expect(parseProjectFlag(['onFoo', '{}'])).toEqual({});
  });

  it('refuses a flag without a value instead of ignoring it', () => {
    expect(parseProjectFlag(['onFoo', '{}', '--project'])).toMatchObject({ error: expect.stringContaining('--project needs a value') });
    expect(parseProjectFlag(['onFoo', '-p', '--timeout', '5s'])).toMatchObject({ error: expect.stringContaining('-p needs a value') });
  });
});

describe('resolvePushProject', () => {
  it('names no project when neither the flag nor QUEUE_PROJECT is given: the daemon derives it from the working directory', () => {
    expect(resolvePushProject({ cwd: work, registryDir, env: {} })).toEqual({ ok: true });
  });

  it('resolves a name, an alias or an id to the project id, and sends the registered path that contains the working directory', async () => {
    const main = folder('app');
    const second = folder('app-docs');
    const project = await addProject(registryDir, { name: 'app', path: main });
    await addPath(registryDir, project.id, second);
    const byFlag = resolvePushProject({ flag: 'app', cwd: join(second, 'sub'), registryDir, env: {} });
    expect(byFlag).toMatchObject({ ok: true, project: project.id });
    expect(byFlag.ok && byFlag.cwd?.replace(/\\/g, '/')).toBe(second.replace(/\\/g, '/'));
    expect(resolvePushProject({ flag: project.id, cwd: work, registryDir, env: {} })).toMatchObject({ ok: true, project: project.id });
  });

  it('uses the main path when the caller is outside the project', async () => {
    const main = folder('app');
    await addProject(registryDir, { name: 'app', path: main });
    const result = resolvePushProject({ flag: 'app', cwd: work, registryDir, env: {} });
    expect(result.ok && result.cwd?.replace(/\\/g, '/')).toBe(main.replace(/\\/g, '/'));
  });

  it('QUEUE_PROJECT is the default project; the flag wins over it', async () => {
    const a = await addProject(registryDir, { name: 'alpha', path: folder('alpha') });
    const b = await addProject(registryDir, { name: 'beta', path: folder('beta') });
    expect(resolvePushProject({ cwd: work, registryDir, env: { QUEUE_PROJECT: 'alpha' } })).toMatchObject({ ok: true, project: a.id });
    expect(resolvePushProject({ flag: 'beta', cwd: work, registryDir, env: { QUEUE_PROJECT: 'alpha' } })).toMatchObject({ ok: true, project: b.id });
  });

  it('refuses a project that does not exist, with the closest names and what to do, instead of pushing without it', async () => {
    await addProject(registryDir, { name: 'alpha', path: folder('alpha') });
    const result = resolvePushProject({ flag: 'alpa', cwd: work, registryDir, env: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('alpa');
    expect(!result.ok && result.message).toContain('alpha');
  });

  it('accepts a project without any path (virtual): the push names the project and sends no working directory (Decision #29)', async () => {
    const project = await addProject(registryDir, { name: 'virtual' });
    const result = resolvePushProject({ flag: 'virtual', cwd: work, registryDir, env: {} });
    expect(result).toEqual({ ok: true, project: project.id });
  });

  it('names where a wrong QUEUE_PROJECT comes from', () => {
    const result = resolvePushProject({ cwd: work, registryDir, env: { QUEUE_PROJECT: 'nope' } });
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
