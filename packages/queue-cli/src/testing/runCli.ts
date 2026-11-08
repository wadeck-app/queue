import { spawn, spawnSync } from 'node:child_process';
import { testBundleFile } from './testBundle.js';

export interface CliResult {
  stdout: string;
  stderr: string;
  /** -1 when the process ended without an exit code (killed by a signal, or never started). */
  exitCode: number;
}

/**
 * Runs the bundled CLI (`queue.cjs` of the test bundle) to the end and returns what it printed. `env` is the environment of the process, always an isolated one
 * (`createIsolatedCliEnv().env`, never `process.env`); `extraEnv` is laid over it for this one call. The timeout is a hang guard, not a performance limit.
 */
export function runQueueCli(env: NodeJS.ProcessEnv, args: string[], options: { extraEnv?: NodeJS.ProcessEnv; cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [testBundleFile('queue.cjs'), ...args], {
    encoding: 'utf-8',
    timeout: 300_000,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    env: { ...env, ...options.extraEnv },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 };
}

/**
 * `runQueueCli` bound to an environment that is only known once the test runs (`getEnv` is called for each run): `const runCli = createCliRunner(() => iso.env)`.
 * `getCwd` gives the working directory of each run (default: the test process's).
 */
export function createCliRunner(getEnv: () => NodeJS.ProcessEnv, getCwd?: () => string | undefined): (args: string[], extraEnv?: NodeJS.ProcessEnv) => CliResult {
  return (args, extraEnv) => {
    const cwd = getCwd?.();
    return runQueueCli(getEnv(), args, { ...(extraEnv !== undefined && { extraEnv }), ...(cwd !== undefined && { cwd }) });
  };
}

/**
 * Asynchronous `runQueueCli`, for tests whose fake server runs in THIS process (a blocking spawnSync would freeze it and the CLI would wait for an answer
 * that can never come). `NODE_OPTIONS` of the test harness is dropped. The timer is a hang guard (the child is killed and the promise rejects), never a limit.
 */
export function runQueueCliAsync(env: NodeJS.ProcessEnv, args: string[], options: { extraEnv?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<CliResult> {
  const fullEnv: NodeJS.ProcessEnv = { ...env, ...options.extraEnv };
  delete fullEnv['NODE_OPTIONS'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [testBundleFile('queue.cjs'), ...args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: fullEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not finish within 300s (hung?): ${args.join(' ')}\n${stderr}`));
    }, 300_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
