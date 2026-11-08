// Test helper: builds an environment in which a spawned queue CLI cannot reach the real machine
// state (config dir, global npm, user npm config, home).
//
// Incident 2026-10-24/25: integration tests ran a repo-built bundle with the REAL config dir and
// the REAL global npm; the background `cli update` executed a real `npm install -g` that was
// killed halfway and left a global CLI uninstalled. Every spawned CLI in a test must use this env.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUE_DAEMON_PORT_ENV, QUEUE_RELAY_PORT_ENV } from '@wadeck-app/queue-core';

/** Nothing listens on the discard port: any npm network access fails fast instead of installing. */
export const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9';

// Variables that steer the updater / launcher / npm / home lookup: a leaked one from the parent
// shell must not change a test, and the real values must never reach the child.
const STRIPPED = /^(UPDATER_|LAUNCHER_|CLI_SELF_CHECK|NPM_CONFIG_|XDG_CONFIG_HOME$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i;

// The kit's daemons ask for a port and walk up to 10 ports further when it is taken: keep the two allocated ports further apart than that,
// so the queue daemon can never drift onto the relay's port (or the other way round).
const MIN_PORT_GAP = 20;
const MAX_ALLOCATION_ATTEMPTS = 20;

/**
 * Two distinct free TCP ports, taken from the OS (bind to port 0, read, close). Synchronous because createIsolatedCliEnv is: a child process
 * does the binding (freePorts.mjs). Another process can in theory take a port between this call and the daemon's bind; the daemon then walks
 * to the next free port (and writes the one it got to config.port, which every client reads), it never fails for that.
 */
export function allocateFreePorts(): { daemonPort: number; relayPort: number } {
  const script = fileURLToPath(new URL('./freePorts.mjs', import.meta.url));
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    let output: string;
    try {
      output = execFileSync(process.execPath, [script, '2'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    } catch (err) {
      throw new Error(`Cannot allocate free ports for the isolated test environment (${script}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const [daemonPort, relayPort] = output.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(daemonPort) || !Number.isInteger(relayPort)) {
      throw new Error(`${script} printed something else than two ports: ${JSON.stringify(output)}`);
    }
    if (Math.abs(daemonPort - relayPort) > MIN_PORT_GAP) {
      return { daemonPort, relayPort };
    }
  }
  throw new Error(`Could not allocate two free ports more than ${MIN_PORT_GAP} apart in ${MAX_ALLOCATION_ATTEMPTS} attempts: the machine's ephemeral port range looks exhausted.`);
}

export interface IsolatedCliEnv {
  /** Root of the throwaway tree (config, home, npm prefix, npm cache). */
  root: string;
  /** Value of QUEUE_CONFIG_DIR; also where ConfigDir.get('queue') resolves under the overridden XDG_CONFIG_HOME. */
  configDir: string;
  npmPrefix: string;
  /** Free port this environment's queue daemon asks for (QUEUE_DAEMON_PORT): never the default 47910, never shared with another environment. */
  daemonPort: number;
  /** Free port this environment's relay daemon asks for (QUEUE_RELAY_PORT). */
  relayPort: number;
  /** Full env for the spawned CLI: parent env minus steering vars, plus the isolation overrides and `extra`. */
  env: NodeJS.ProcessEnv;
  /** Removes the whole tree. Call from an afterAll/afterEach hook. */
  cleanup(): void;
}

/**
 * @param opts.registry registry URL for npm (default: unreachable).
 * @param opts.extra    extra env entries, applied last.
 * @param opts.allocatePorts test seam: replaces the allocation of the two free ports (receives the root of the tree, to check what a failure leaves behind).
 *
 * The throwaway tree is removed again when building the environment fails half way (no free port, a directory that cannot be created): the caller gets the
 * error and no environment, so nobody could call cleanup().
 */
export function createIsolatedCliEnv(opts: IsolatedCliEnvOptions = {}): IsolatedCliEnv {
  const root = mkdtempSync(join(tmpdir(), 'queue-test-iso-'));
  try {
    return buildIsolatedCliEnv(root, opts);
  } catch (err) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw err;
  }
}

interface IsolatedCliEnvOptions {
  registry?: string;
  extra?: NodeJS.ProcessEnv;
  allocatePorts?: (root: string) => { daemonPort: number; relayPort: number };
}

function buildIsolatedCliEnv(root: string, opts: IsolatedCliEnvOptions): IsolatedCliEnv {
  const registry = opts.registry ?? UNREACHABLE_REGISTRY;
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

  const { daemonPort, relayPort } = (opts.allocatePorts ?? allocateFreePorts)(root);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIPPED.test(k)) {
      env[k] = v;
    }
  }
  Object.assign(env, {
    QUEUE_CONFIG_DIR: configDir,
    // Never the real daemon's fixed ports: tests (and parallel test runs, and other sessions) must not share a port
    [QUEUE_DAEMON_PORT_ENV]: String(daemonPort),
    [QUEUE_RELAY_PORT_ENV]: String(relayPort),
    // A daemon of this environment re-registers the queue module with app-core on every start: never with a real app-core (port 1 is never
    // listening), and its pickup file lands in this environment's own directory, not in one shared by every test
    APP_CORE_PORT: '1',
    APP_CORE_CONFIG_DIR: join(root, 'app-core'),
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
    root, configDir, npmPrefix, daemonPort, relayPort, env,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
