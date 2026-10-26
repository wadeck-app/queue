import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject } from '@wadeck-app/project-sdk';
import { listProjectOptions } from './projects.js';

let registryDir: string;
// The folders of the registered projects, in one temp dir removed with the rest
let foldersDir: string;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'app-module-projects-'));
  foldersDir = mkdtempSync(join(tmpdir(), 'app-module-projects-folders-'));
  mkdirSync(join(foldersDir, 'zed'));
  mkdirSync(join(foldersDir, 'app'));
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(foldersDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('listProjectOptions', () => {
  it('is empty when no project is registered, so the dashboard shows no selector', () => {
    expect(listProjectOptions(registryDir)).toEqual([]);
  });

  it('lists the registered projects as select options: the id is the value, the name the label, sorted by name', async () => {
    const zed = await addProject(registryDir, { name: 'zed', path: join(foldersDir, 'zed') });
    const app = await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') });
    expect(listProjectOptions(registryDir)).toEqual([
      { value: app.id, label: 'app' },
      { value: zed.id, label: 'zed' },
    ]);
  });

  it('throws on an unreadable registry, naming it, instead of answering with an empty list', () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    expect(() => listProjectOptions(registryDir)).toThrow();
  });
});
