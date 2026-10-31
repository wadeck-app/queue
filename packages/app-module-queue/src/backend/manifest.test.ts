import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('keeps the id queue-cli registers it as (queue-cli/src/daemon/AppCoreRegistration.ts APP_CORE_MODULE_ID)', () => {
    const registration = readFileSync(join(packageDir, '../queue-cli/src/daemon/AppCoreRegistration.ts'), 'utf8');
    expect(registration).toContain(`APP_CORE_MODULE_ID = '${String(manifest.id)}'`);
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
