import { getErrorMessage } from './errors.js';
import { spawn } from 'node:child_process';
import { statSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// Starting the daemon means running `queue start`. The SDK never imports or bundles the CLI and never puts anything but the
// constant argument `start` on the command line: the config dir travels in the environment, the event never travels here.

const SPAWNABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Looks for the `queue` executable the way a shell would: PATH entries, times PATHEXT on Windows, the executable bit elsewhere.
 * Pure Node, no `which`. On Windows only extensions that can be spawned (.com .exe .bat .cmd) count.
 */
export function findQueueExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, probe: (path: string) => boolean = isRunnableFile): string | undefined {
  const pathValue = readEnv(env, 'PATH', platform);
  if (pathValue === undefined) {
    return undefined;
  }
  const separator = platform === 'win32' ? ';' : delimiter === ';' ? ':' : delimiter;
  const directories = pathValue
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '');
  const names =
    platform === 'win32'
      ? (readEnv(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
          .split(';')
          .filter((extension) => SPAWNABLE_EXTENSIONS.includes(extension.toLowerCase()))
          .map((extension) => `queue${extension}`)
      : ['queue'];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (probe(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface RunOutcome {
  /** Exit code, null when the process could not be started or was stopped. */
  code: number | null;
  error?: string;
}

const RUN_TIMEOUT_MS = 15000;

function needsShell(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

/** Runs `<executable> start` with QUEUE_CONFIG_DIR set. Never rejects. Output is discarded (a non-TTY shim prints nothing anyway). */
export function runQueueStart(executable: string, configDir: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const shell = needsShell(executable);
    if (shell && /["%^!&|<>]/.test(executable)) {
      resolve({ code: null, error: `refusing to run ${executable} through the Windows shell: the path holds an unsafe character (one of " % ^ ! & | < >), install queue-cli in another directory` });
      return;
    }
    try {
      const env = { ...baseEnv, QUEUE_CONFIG_DIR: configDir };
      // With a shell, the whole command is one constant string (quoted path + `start`): passing an args array together with
      // `shell: true` is deprecated by Node because the arguments are concatenated unescaped.
      const child = shell
        ? spawn(`"${executable}" start`, { env, stdio: 'ignore', windowsHide: true, timeout: RUN_TIMEOUT_MS, shell: true })
        : spawn(executable, ['start'], { env, stdio: 'ignore', windowsHide: true, timeout: RUN_TIMEOUT_MS });
      child.on('error', (error) => resolve({ code: null, error: getErrorMessage(error) }));
      child.on('close', (code, signal) => resolve(code === null ? { code, error: `stopped by ${signal ?? 'a signal'} (after ${RUN_TIMEOUT_MS} ms at most)` } : { code }));
    } catch (error) {
      resolve({ code: null, error: getErrorMessage(error) });
    }
  });
}

export interface StartDeps {
  find: () => string | undefined;
  run: (executable: string, configDir: string) => Promise<RunOutcome>;
  /** True once the daemon answers and is verified (the daemon resolver, steps 1-2 of the plan). */
  ready: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  timeoutMs: number;
}

export type StartResult = { ok: true } | { ok: false; kind: 'not-installed' | 'start-failed' | 'not-ready'; reason: string; exitCode?: number };

export function defaultStartDeps(ready: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env): StartDeps {
  return {
    find: () => findQueueExecutable(env),
    run: (executable, configDir) => runQueueStart(executable, configDir, env),
    ready,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollIntervalMs: 100,
    timeoutMs: 5000,
  };
}

/** Starts the daemon through `queue start`, then waits for it to answer. Single flight is the caller's job. Never throws. */
export async function startDaemon(configDir: string, deps: StartDeps): Promise<StartResult> {
  const executable = deps.find();
  if (executable === undefined) {
    return { ok: false, kind: 'not-installed', reason: 'queue is not installed or not on PATH: install queue-cli (npm install -g @wadeck-app/queue-cli) and make sure `queue` runs in this environment' };
  }
  const outcome = await deps.run(executable, configDir);
  if (outcome.code !== 0) {
    // Another process may have started the daemon at the same time: one check before giving up.
    if (await deps.ready()) {
      return { ok: true };
    }
    const detail = outcome.code === null ? `could not run it${outcome.error !== undefined ? `: ${outcome.error}` : ''}` : `exit code ${outcome.code}`;
    return {
      ok: false,
      kind: 'start-failed',
      reason: `\`${executable} start\` failed (${detail}): run it in a terminal to see why`,
      ...(outcome.code !== null && { exitCode: outcome.code }),
    };
  }
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    if (await deps.ready()) {
      return { ok: true };
    }
    if (deps.now() >= deadline) {
      return { ok: false, kind: 'not-ready', reason: `\`${executable} start\` exited 0 but the daemon did not answer within ${deps.timeoutMs} ms: run \`queue status\` in a terminal to see why` };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}
