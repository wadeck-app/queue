import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredRoutes } from './registeredRoutes.testUtil.js';
import { getStatus } from './status.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as {
  id?: string;
  version?: unknown;
  backendEntryPath?: unknown;
  expose?: { slots?: Record<string, { accepts: string[] }> };
  extensionPoints: { view: { type: string; value: string } }[];
};

describe('manifest.json (source manifest of the app-core-cli layout)', () => {
  it('declares the id the module is registered under: app-core refuses a manifest without it ("Required" at path id)', () => {
    expect(manifest.id).toBe('queue');
  });

  it('holds neither version nor backendEntryPath: `app-core-cli package` stamps the first and fixes the second', () => {
    expect(manifest).not.toHaveProperty('version');
    expect(manifest).not.toHaveProperty('backendEntryPath');
  });

  it('references every view as ./src/dsl-views/<file> and each of them exists', () => {
    const paths = manifest.extensionPoints.map((point) => point.view.value);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).toMatch(/^\.\/src\/dsl-views\/[\w.-]+\.ya?ml$/);
      expect(existsSync(join(packageDir, path))).toBe(true);
    }
  });

  it('references every view file of src/dsl-views: a view nobody lists is never shown', () => {
    const listed = manifest.extensionPoints.map((point) => point.view.value.replace('./src/dsl-views/', '')).sort();
    const present = readdirSync(join(packageDir, 'src/dsl-views')).sort();
    expect(listed).toEqual(present);
  });

  // Contributors are checked against this list by `app-core-cli check` and at load; the types are components the shell registers (Badge with href: relay-badge.yaml)
  it('exposes the project-header slot, which accepts only link-like roots (queue:project-header)', () => {
    expect(manifest.expose).toEqual({ slots: { 'project-header': { accepts: ['Badge', 'Link', 'ButtonLink'] } } });
  });

  it('does not expose a slot named nav (reserved by app-core)', () => {
    expect(Object.keys(manifest.expose?.slots ?? {})).not.toContain('nav');
  });
});

describe('manifest.json figures next to menu entries (count)', () => {
  type Count = { route: string; field: string; refreshSeconds?: number };
  const pages = (manifest.extensionPoints as unknown as { slot?: string; path?: string; count?: Count }[]).filter((point) => point.slot === 'nav');

  it('Pending shows the number of events in flight (what its page lists: pending and failed) and DLQ the number of dead-letter entries, both read from /status', () => {
    expect(pages.find((page) => page.path === '/pending')?.count).toEqual({ route: '/status', field: 'inFlightCount' });
    expect(pages.find((page) => page.path === '/dlq')?.count).toEqual({ route: '/status', field: 'dlqCount' });
  });

  it('every count points at a GET route the backend registers and at a whole number that route answers', () => {
    const registered = registeredRoutes();
    const dir = mkdtempSync(join(tmpdir(), 'queue-manifest-count-'));
    try {
      const answer = getStatus(dir) as unknown as Record<string, unknown>;
      const counted = pages.filter((page) => page.count !== undefined);
      expect(counted.length).toBeGreaterThan(0);
      for (const page of counted) {
        const count = page.count as Count;
        expect(registered, `${page.path}: count.route ${count.route}`).toContain(`GET ${count.route}`);
        expect(Number.isInteger(answer[count.field]), `${page.path}: /status field ${count.field}`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
