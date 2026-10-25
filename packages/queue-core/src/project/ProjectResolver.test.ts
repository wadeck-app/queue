import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject } from '@wadeck-app/project-sdk';
import { ProjectResolver } from './ProjectResolver.js';

let registryDir: string;
let workDir: string;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'queue-registry-'));
  workDir = mkdtempSync(join(tmpdir(), 'queue-projects-'));
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function folder(name: string): string {
  const path = join(workDir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('ProjectResolver', () => {
  it('finds the registered project that contains the cwd, deepest registered path first', async () => {
    const app = folder('app');
    const sub = folder('app/packages/api');
    await addProject(registryDir, { name: 'app', path: app });
    const inner = await addProject(registryDir, { name: 'api', path: sub });
    const found = new ProjectResolver(registryDir).lookup(join(sub, 'src'));
    expect(found).toMatchObject({ kind: 'registered', project: { id: inner.id, name: 'api' } });
  });

  it('says a cwd outside every registered project is unregistered, with the command that registers it', () => {
    const cwd = folder('elsewhere');
    const found = new ProjectResolver(registryDir).lookup(cwd);
    expect(found.kind).toBe('unregistered');
    expect((found as { warning: string }).warning).toContain(cwd);
    expect((found as { warning: string }).warning).toContain(`project add "${cwd}"`);
    expect((found as { warning: string }).warning).toContain('global subscribers');
  });

  it('reports an unreadable registry as such, with the reason, instead of pretending the project is unregistered', () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    const found = new ProjectResolver(registryDir).lookup(folder('app'));
    expect(found.kind).toBe('unavailable');
    expect((found as { problem: string }).problem).toContain(registryDir);
  });

  it('sees a project registered after it was created (the registry is read at each lookup, the daemon outlives the registrations)', async () => {
    const app = folder('app');
    const resolver = new ProjectResolver(registryDir);
    expect(resolver.lookup(app).kind).toBe('unregistered');
    await addProject(registryDir, { name: 'app', path: app });
    expect(resolver.lookup(app).kind).toBe('registered');
  });
});

describe('ProjectResolver.lookupId (an explicit project id of a push)', () => {
  it('finds a registered project by its id', async () => {
    const project = await addProject(registryDir, { name: 'app', path: folder('app') });
    expect(new ProjectResolver(registryDir).lookupId(project.id)).toMatchObject({ kind: 'registered', project: { id: project.id, name: 'app' } });
  });

  it('says an id the registry does not know is unknown, with the command that lists the projects', () => {
    const found = new ProjectResolver(registryDir).lookupId('deadbeef');
    expect(found.kind).toBe('unregistered');
    expect((found as { warning: string }).warning).toContain("'deadbeef'");
    expect((found as { warning: string }).warning).toContain('project list');
  });

  it('reports an unreadable registry as such', () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    expect(new ProjectResolver(registryDir).lookupId('deadbeef').kind).toBe('unavailable');
  });
});
