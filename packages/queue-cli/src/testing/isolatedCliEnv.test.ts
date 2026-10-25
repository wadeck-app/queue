import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createIsolatedCliEnv, UNREACHABLE_REGISTRY, type IsolatedCliEnv } from './isolatedCliEnv.js';

describe('createIsolatedCliEnv', () => {
  let iso: IsolatedCliEnv | undefined;
  const saved = { ...process.env };

  afterEach(() => {
    iso?.cleanup();
    iso = undefined;
    process.env = { ...saved };
  });

  it('points every steering variable into the throwaway tree and strips leaked ones', () => {
    process.env['UPDATER_FORCE'] = '1';
    process.env['LAUNCHER_BUNDLE_OVERRIDE'] = '/real/queue.cjs';
    process.env['npm_config_registry'] = 'https://real.example';
    iso = createIsolatedCliEnv();
    const e = iso.env;
    expect(e['UPDATER_FORCE']).toBeUndefined();
    expect(e['LAUNCHER_BUNDLE_OVERRIDE']).toBeUndefined();
    expect(e['QUEUE_CONFIG_DIR']).toBe(iso.configDir);
    expect(e['NPM_CONFIG_REGISTRY']).toBe(UNREACHABLE_REGISTRY);
    for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) {
      expect(e[k]?.startsWith(iso.root), `${k}=${e[k]}`).toBe(true);
    }
    expect(existsSync(iso.configDir)).toBe(true);
    iso.cleanup();
    expect(existsSync(iso.root)).toBe(false);
  });
});
