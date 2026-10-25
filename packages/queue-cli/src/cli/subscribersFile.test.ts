import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { subscribersFileFor } from './subscribersFile.js';

let registryDir: string;
let work: string;
let configDir: string;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'queue-subs-registry-'));
  work = mkdtempSync(join(tmpdir(), 'queue-subs-work-'));
  configDir = join(work, 'queue-config');
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

describe('subscribersFileFor', () => {
  it('global: the subscribers.yml of the queue config folder', () => {
    expect(subscribersFileFor('global', { configDir, cwd: work, registryDir })).toEqual({ file: join(configDir, 'subscribers.yml') });
  });

  it('project, in a registered project: the file of its config folder in the registry, created if needed', async () => {
    const app = folder('app');
    const project = await addProject(registryDir, { name: 'app', path: app });
    const result = subscribersFileFor('project', { configDir, cwd: join(app, 'src'), registryDir });
    expect(result).toEqual({ file: join(projectToolDir(registryDir, project.id, 'queue', 'config'), 'subscribers.yml'), createDir: true });
  });

  it('project, outside every registered project: the .queue/subscribers.yml of the working directory, with the warning that says what to do', () => {
    const elsewhere = folder('elsewhere');
    const result = subscribersFileFor('project', { configDir, cwd: elsewhere, registryDir });
    expect(result).toMatchObject({ file: join(elsewhere, '.queue', 'subscribers.yml'), createDir: true });
    expect('warning' in result && result.warning).toContain(`project add "${elsewhere}"`);
  });

  it('project, with an unreadable registry: refuses, with the reason, instead of writing somewhere else', () => {
    const broken = join(work, 'broken-registry');
    mkdirSync(broken);
    writeFileSync(join(broken, 'registry.json'), '{ not json');
    const result = subscribersFileFor('project', { configDir, cwd: work, registryDir: broken });
    expect('error' in result && result.error).toContain(broken);
  });
});
