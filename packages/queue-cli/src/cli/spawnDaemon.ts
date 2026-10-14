import { spawnDetachedProcess } from '@wadeck-app/queue-core';

/**
 * Dependency injection interface for testability.
 */
export interface ScriptResolutionDeps {
  existsSync: (path: string) => boolean;
  bundlePath: string;
  tscPath: string;
}

/**
 * Resolves the daemon script path: prefers bundled queue-daemon.cjs if it exists,
 * otherwise falls back to the TSC-compiled daemon-entry.js.
 */
export function resolveDaemonScript(deps: ScriptResolutionDeps): string {
  const { existsSync, bundlePath, tscPath } = deps;
  return existsSync(bundlePath) ? bundlePath : tscPath;
}

/**
 * Spawns the queue daemon process as a fully detached background process.
 * Resolves the daemon script (bundle or tsc), then delegates to spawnDetachedProcess
 * for cross-platform detached spawning with hidden console on Windows.
 * Optionally accepts additional env vars to pass to the child process.
 */
export function spawnDaemon(configDir: string, deps: ScriptResolutionDeps, extraEnv?: Record<string, string>): void {
  const daemonScript = resolveDaemonScript(deps);
  spawnDetachedProcess(daemonScript, { QUEUE_CONFIG_DIR: configDir, ...extraEnv });
}

/**
 * Exports the daemon script path resolution for reuse by other modules.
 * Returns the daemon script path according to the same resolution logic.
 */
export function getDaemonScriptPath(deps: ScriptResolutionDeps): string {
  return resolveDaemonScript(deps);
}
