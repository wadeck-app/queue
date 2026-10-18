import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

describe('manifest.json', () => {
  it('declares the id the module is registered under: app-core refuses a manifest without it ("Required" at path id)', () => {
    expect(manifest['id']).toBe('queue');
  });

  it('keeps the id queue-cli registers it as (queue-cli/src/daemon/AppCoreRegistration.ts APP_CORE_MODULE_ID)', () => {
    const registration = readFileSync(join(dirname(manifestPath), '../queue-cli/src/daemon/AppCoreRegistration.ts'), 'utf8');
    expect(registration).toContain(`APP_CORE_MODULE_ID = '${String(manifest['id'])}'`);
  });
});
