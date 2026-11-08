import { spawnSync } from 'node:child_process';
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
