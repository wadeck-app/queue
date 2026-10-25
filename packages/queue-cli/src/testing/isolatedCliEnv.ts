// Test helper: builds an environment in which a spawned queue CLI cannot reach the real machine
// state (config dir, global npm, user npm config, home).
//
// Incident 2026-10-24/25: integration tests ran a repo-built bundle with the REAL config dir and
// the REAL global npm; the background `cli update` executed a real `npm install -g` that was
// killed halfway and left a global CLI uninstalled. Every spawned CLI in a test must use this env.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Nothing listens on the discard port: any npm network access fails fast instead of installing. */
export const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9';

// Variables that steer the updater / launcher / npm / home lookup: a leaked one from the parent
// shell must not change a test, and the real values must never reach the child.
const STRIPPED = /^(UPDATER_|LAUNCHER_|CLI_SELF_CHECK|NPM_CONFIG_|XDG_CONFIG_HOME$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i;

export interface IsolatedCliEnv {
  /** Root of the throwaway tree (config, home, npm prefix, npm cache). */
  root: string;
  /** Value of QUEUE_CONFIG_DIR; also where ConfigDir.get('queue') resolves under the overridden XDG_CONFIG_HOME. */
  configDir: string;
  npmPrefix: string;
  /** Full env for the spawned CLI: parent env minus steering vars, plus the isolation overrides and `extra`. */
  env: NodeJS.ProcessEnv;
  /** Removes the whole tree. Call from an afterAll/afterEach hook. */
  cleanup(): void;
}

/**
 * @param opts.registry registry URL for npm (default: unreachable).
 * @param opts.extra    extra env entries, applied last.
 */
export function createIsolatedCliEnv(opts: { registry?: string; extra?: NodeJS.ProcessEnv } = {}): IsolatedCliEnv {
  const registry = opts.registry ?? UNREACHABLE_REGISTRY;
  const root = mkdtempSync(join(tmpdir(), 'queue-test-iso-'));
  const home = join(root, 'home');
  const configDir = join(home, '.config', 'queue');
  const npmPrefix = join(root, 'npm-prefix');
  const npmCache = join(root, 'npm-cache');
  for (const d of [home, configDir, npmPrefix, npmCache, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) {
    mkdirSync(d, { recursive: true });
  }
  // Own npm config files for user AND global level (npm refuses the same file for both), so the
  // real user-level npm config (auth tokens, scope registries) is never read.
  const npmConfig = `registry=${registry}
@wadeck-app:registry=${registry}
fetch-retries=0
fetch-timeout=3000
audit=false
fund=false
update-notifier=false
`;
  const npmUserConfig = join(root, 'npm-user.ini');
  const npmGlobalConfig = join(root, 'npm-global.ini');
  writeFileSync(npmUserConfig, npmConfig);
  writeFileSync(npmGlobalConfig, npmConfig);

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIPPED.test(k)) {
      env[k] = v;
    }
  }
  Object.assign(env, {
    QUEUE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: join(home, '.config'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_REGISTRY: registry,
    // A project-level .npmrc naming the @wadeck-app registry outranks the userconfig file;
    // only this env variable beats it (otherwise `npm view` from a test reaches npm.pkg.github.com).
    'npm_config_@wadeck-app:registry': registry,
  }, opts.extra);

  return {
    root, configDir, npmPrefix, env,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
