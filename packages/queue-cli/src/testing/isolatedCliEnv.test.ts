import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
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

  it('gives each environment its own free daemon and relay ports, never the defaults, overriding what the parent shell exports', async () => {
    process.env['QUEUE_DAEMON_PORT'] = '47910';
    process.env['QUEUE_RELAY_PORT'] = '47911';
    iso = createIsolatedCliEnv();
    const other = createIsolatedCliEnv();
    try {
      expect(iso.env['QUEUE_DAEMON_PORT']).toBe(String(iso.daemonPort));
      expect(iso.env['QUEUE_RELAY_PORT']).toBe(String(iso.relayPort));
      const ports = [iso.daemonPort, iso.relayPort, other.daemonPort, other.relayPort];
      expect(new Set(ports).size).toBe(4);
      for (const port of ports) {
        expect([47910, 47911]).not.toContain(port);
      }
      expect(Math.abs(iso.daemonPort - iso.relayPort)).toBeGreaterThan(10);
      // The allocated ports are free: one can bind right away
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(iso!.daemonPort, '127.0.0.1', () => server.close(() => resolve()));
      });
    } finally {
      other.cleanup();
    }
  });
});
