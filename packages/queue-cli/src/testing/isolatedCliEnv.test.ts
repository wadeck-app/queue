import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { allocateFreePorts, createIsolatedCliEnv, UNREACHABLE_REGISTRY, type IsolatedCliEnv } from './isolatedCliEnv.js';

describe('createIsolatedCliEnv', () => {
  let iso: IsolatedCliEnv | undefined;

  afterEach(() => {
    iso?.cleanup();
    iso = undefined;
    // Puts back each variable this file stubbed; process.env itself is never replaced (on Windows it is a special object: case-insensitive names)
    vi.unstubAllEnvs();
  });

  it('points every steering variable into the throwaway tree and strips leaked ones', () => {
    vi.stubEnv('UPDATER_FORCE', '1');
    vi.stubEnv('LAUNCHER_BUNDLE_OVERRIDE', '/real/queue.cjs');
    vi.stubEnv('npm_config_registry', 'https://real.example');
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
    vi.stubEnv('QUEUE_DAEMON_PORT', '47910');
    vi.stubEnv('QUEUE_RELAY_PORT', '47911');
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

  it('leaves process.env the same object and restores what a test stubbed', () => {
    const before = process.env;
    vi.stubEnv('UPDATER_FORCE', '1');
    iso = createIsolatedCliEnv();
    vi.unstubAllEnvs();
    expect(process.env).toBe(before);
    expect(process.env['UPDATER_FORCE']).toBeUndefined();
  });

  it('removes its throwaway tree when it cannot finish building the environment (no leaked directory)', () => {
    let root = '';
    expect(() => createIsolatedCliEnv({
      allocatePorts: (createdRoot) => {
        root = createdRoot;
        throw new Error('no free port');
      },
    })).toThrow('no free port');
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });
  it('strips every npm and self-check variable of the parent shell, keeps the others, and lets `extra` win', () => {
    vi.stubEnv('NPM_CONFIG_AUTHTOKEN', 'real-token');
    vi.stubEnv('NPM_CONFIG_PROXY', 'http://real-proxy.example');
    vi.stubEnv('CLI_SELF_CHECK_SKIP', '1');
    vi.stubEnv('CLI_SELF_CHECK', '1');
    vi.stubEnv('QUEUE_S4_KEPT', 'kept');
    iso = createIsolatedCliEnv({ extra: { UPDATER_FORCE: 'from-extra' } });
    const names = Object.keys(iso.env);
    expect(names.filter((k) => /^NPM_CONFIG_(AUTHTOKEN|PROXY)$/i.test(k))).toEqual([]);
    expect(names.filter((k) => /^CLI_SELF_CHECK/i.test(k))).toEqual([]);
    expect(JSON.stringify(iso.env)).not.toContain('real-token');
    expect(iso.env['QUEUE_S4_KEPT']).toBe('kept');
    expect(iso.env['UPDATER_FORCE']).toBe('from-extra');
  });

  it('gives the environment its own app-core directory and registry override for the @wadeck-app scope', () => {
    vi.stubEnv('APP_CORE_CONFIG_DIR', '/real/app-core');
    vi.stubEnv('npm_config_@wadeck-app:registry', 'https://npm.pkg.github.com');
    iso = createIsolatedCliEnv({ registry: 'http://127.0.0.1:1234' });
    expect(iso.env['APP_CORE_CONFIG_DIR']).toBe(join(iso.root, 'app-core'));
    expect(iso.env['APP_CORE_PORT']).toBe('1');
    expect(iso.env['npm_config_@wadeck-app:registry']).toBe('http://127.0.0.1:1234');
    expect(iso.env['NPM_CONFIG_REGISTRY']).toBe('http://127.0.0.1:1234');
  });
});

describe('allocateFreePorts', () => {
  it('asks again until the two ports are more than 20 apart', () => {
    const outputs = ['5000 5005\n', '5000 5020\n', '5000 5021\n'];
    const run = vi.fn(() => outputs.shift() as string);
    expect(allocateFreePorts(run)).toEqual({ daemonPort: 5000, relayPort: 5021 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('accepts a relay port below the daemon port when far enough', () => {
    expect(allocateFreePorts(() => '6000 5000')).toEqual({ daemonPort: 6000, relayPort: 5000 });
  });

  it('gives up with an actionable error after 20 attempts that stay too close', () => {
    const run = vi.fn(() => '5000 5001');
    expect(() => allocateFreePorts(run)).toThrow(/more than 20 apart in 20 attempts/);
    expect(run).toHaveBeenCalledTimes(20);
  });

  it('names the script when it prints something else than two ports, and when it fails', () => {
    expect(() => allocateFreePorts(() => 'oops')).toThrow(/freePorts\.mjs printed something else/);
    expect(() => allocateFreePorts(() => { throw new Error('boom'); })).toThrow(/Cannot allocate free ports.*boom/);
  });
});
