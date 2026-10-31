import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, removeProject } from '@wadeck-app/project-sdk';
import { getProjectScope } from './projectScope.js';

let registryDir: string;
let foldersDir: string;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'app-module-scope-'));
  foldersDir = mkdtempSync(join(tmpdir(), 'app-module-scope-folders-'));
  mkdirSync(join(foldersDir, 'app'));
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(foldersDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('getProjectScope', () => {
  it('finds a registered project: id, name, found', async () => {
    const project = await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') });
    expect(getProjectScope(registryDir, project.id)).toEqual({ id: project.id, name: 'app', found: true });
  });

  it('finds a virtual project', async () => {
    const project = await addProject(registryDir, { name: 'ghost' });
    expect(getProjectScope(registryDir, project.id)).toEqual({ id: project.id, name: 'ghost', found: true });
  });

  it('finds a soft-deleted project: the records keep its id', async () => {
    const project = await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') });
    await removeProject(registryDir, project.id);
    expect(getProjectScope(registryDir, project.id)).toEqual({ id: project.id, name: 'app', found: true });
  });

  it('answers found false (not an error) for an unknown id, keeping the id', () => {
    expect(getProjectScope(registryDir, 'deadbeef')).toEqual({ id: 'deadbeef', name: '', found: false });
  });

  it.each([undefined, '', 'nope', 'DEADBEEF', ['deadbeef', 'deadbeef'], 42])('answers found false with an empty id for the unusable value %j', (value) => {
    expect(getProjectScope(registryDir, value)).toEqual({ id: '', name: '', found: false });
  });

  it('throws on a corrupt registry: hiding the header without saying why would be silent', () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    expect(() => getProjectScope(registryDir, 'deadbeef')).toThrow();
  });
});
