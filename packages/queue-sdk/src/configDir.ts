import { homedir } from 'node:os';
import { join } from 'node:path';

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * The queue config dir, resolved like the CLI: QUEUE_CONFIG_DIR, else $XDG_CONFIG_HOME/queue, else ~/.config/queue.
 * Empty or blank variables are ignored (a shell that exports `VAR=` must not point the SDK at the current directory).
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = nonEmpty(env['QUEUE_CONFIG_DIR']);
  if (explicit !== undefined) {
    return explicit;
  }
  const xdg = nonEmpty(env['XDG_CONFIG_HOME']);
  return xdg !== undefined ? join(xdg, 'queue') : join(home, '.config', 'queue');
}
