import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHealth } from './health.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

let configDir: string;
let registryDir: string;

beforeEach(() => {
  configDir = makeTempDir('app-module-health-');
  registryDir = makeTempDir('app-module-health-registry-');
});

afterEach(() => {
  removeTempDir(configDir);
  removeTempDir(registryDir);
});

describe('getHealth', () => {
  it('a queue that never ran is healthy: every page reads empty files', async () => {
    const answer = await getHealth(configDir, registryDir);
    expect(answer.checks.filter((one) => !one.ok)).toEqual([]);
    expect(answer.ok).toBe(true);
    expect(answer.checks.map((one) => one.name)).toEqual(['queue-files', 'history', 'subscribers', 'waiters', 'projects', 'daemon']);
  });

  it('the daemon being down never fails it, and says what it stops', async () => {
    const answer = await getHealth(configDir, registryDir);
    const daemon = answer.checks.find((one) => one.name === 'daemon');
    expect(daemon?.ok).toBe(true);
    expect(daemon?.detail).toMatch(/not running|running|no answer/);
  });

  it('a project registry that cannot be read fails the projects check, with its reason, and the answer', async () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    const answer = await getHealth(configDir, registryDir);
    expect(answer.ok).toBe(false);
    const projects = answer.checks.find((one) => one.name === 'projects');
    expect(projects?.ok).toBe(false);
    expect(projects?.detail).toBeTruthy();
  });

  it('a waiters folder that cannot be listed fails the waiters check only', async () => {
    // A file where the folder should be
    writeFileSync(join(configDir, 'waiters'), 'x');
    const answer = await getHealth(configDir, registryDir);
    expect(answer.checks.filter((one) => !one.ok).map((one) => one.name)).toEqual(['waiters']);
  });

  it('the history check opens the newest day file without parsing any, and a history that is not a folder fails it', async () => {
    mkdirSync(join(configDir, 'history'), { recursive: true });
    writeFileSync(join(configDir, 'history', '2026-11-09.ndjson'), '{ not even json\n');
    const read = await getHealth(configDir, registryDir);
    expect(read.checks.find((one) => one.name === 'history')).toEqual({ name: 'history', ok: true, detail: '1 day files' });
    const other = makeTempDir('app-module-health-file-');
    try {
      writeFileSync(join(other, 'history'), 'x');
      const broken = await getHealth(other, registryDir);
      expect(broken.checks.filter((one) => !one.ok).map((one) => one.name)).toEqual(['history']);
    } finally {
      removeTempDir(other);
    }
  });

  it('reads the queue files it reports', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'dlq.ndjson'), JSON.stringify({ id: 'x', event: 'onFoo', payload: {}, meta: { cwd: '/p', projectName: 'p' }, subscriberId: 's', attempts: 3, lastError: 'x', movedAt: '2026-10-18T12:00:00.000Z' }) + '\n');
    const answer = await getHealth(configDir, registryDir);
    expect(answer.checks[0]).toMatchObject({ name: 'queue-files', ok: true, detail: '0 pending, 0 in flight, 1 in the DLQ' });
  });
});
