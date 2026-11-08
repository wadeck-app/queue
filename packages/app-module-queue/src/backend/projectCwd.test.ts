import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addProject, removeProject } from '@wadeck-app/project-sdk';
import { resolveProjectCwd } from './projectCwd.js';
import { InvalidQueryError, UnknownProjectError } from './errors.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

let registryDir: string;
let foldersDir: string;

beforeEach(() => {
  registryDir = makeTempDir('app-module-cwd-');
  foldersDir = makeTempDir('app-module-cwd-folders-');
  mkdirSync(join(foldersDir, 'app'));
});

afterEach(() => {
  removeTempDir(registryDir);
  removeTempDir(foldersDir);
});

describe('resolveProjectCwd', () => {
  it('gives the main folder of a registered project and its name', async () => {
    const project = await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') });
    const resolved = resolveProjectCwd(registryDir, project.id);
    expect(resolved.projectName).toBe('app');
    expect(resolved.cwd).toBe(project.paths.find((entry) => entry.main)!.path);
  });

  it('refuses a malformed id with the shared 400 wording', () => {
    expect(() => resolveProjectCwd(registryDir, 'nope')).toThrowError(InvalidQueryError);
  });

  it('refuses an id in no registry, saying how to list the projects', () => {
    expect(() => resolveProjectCwd(registryDir, 'deadbeef')).toThrowError(UnknownProjectError);
    expect(() => resolveProjectCwd(registryDir, 'deadbeef')).toThrowError(/project list/);
  });

  it('refuses a removed project: its subscribers no longer apply, pushing from its old folder would be misleading', async () => {
    const project = await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') });
    await removeProject(registryDir, project.id);
    expect(() => resolveProjectCwd(registryDir, project.id)).toThrowError(UnknownProjectError);
    expect(() => resolveProjectCwd(registryDir, project.id)).toThrowError(/removed/);
  });

  it('refuses a virtual project (no folder) with what to do', async () => {
    const project = await addProject(registryDir, { name: 'ghost' });
    expect(() => resolveProjectCwd(registryDir, project.id)).toThrowError(InvalidQueryError);
    expect(() => resolveProjectCwd(registryDir, project.id)).toThrowError(/no folder/);
  });
});
