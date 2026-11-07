import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';

export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The directories of PATH in `env`, quotes removed, empty entries dropped. */
export function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, 'PATH') ?? '').split(delimiter).map((d) => d.replace(/^"|"$/g, '')).filter((d) => d !== '');
}

/** PATH as one line for a message: the first `maxEntries` directories, then how many more there are ("PATH is empty" when it is). */
export function describeSearchPath(env: NodeJS.ProcessEnv, maxEntries: number): string {
  const directories = pathDirectories(env);
  if (directories.length === 0) {
    return 'PATH is empty or not set';
  }
  const shown = directories.slice(0, maxEntries).join('; ');
  return directories.length > maxEntries ? `${directories.length} PATH entries: ${shown}; ... (+${directories.length - maxEntries} more)` : `${directories.length} PATH entries: ${shown}`;
}

/**
 * How many PATH entries the daemon searches, for an error message: the count only, never the directories (they hold the user name and the tool locations,
 * and an error reaches the DLQ and the `queue.dlq.added` event that other subscribers see). The full list is logged once at daemon start (`queue logs`).
 */
export function describePathEntryCount(env: NodeJS.ProcessEnv): string {
  const count = pathDirectories(env).length;
  if (count === 0) {
    return 'PATH is empty or not set';
  }
  return count === 1 ? '1 PATH entry' : `${count} PATH entries`;
}

/**
 * The file `program` designates on Windows, trying the PATHEXT extensions. A bare name (`tool`) is looked up on PATH ONLY: the working directory of a
 * subscriber is often a cloned project, and a `tool.cmd` planted there must not run in place of the real tool (cmd.exe would run it; this does not).
 * A program written with a directory (`./tool.cmd`, `sub\tool`, `C:\x\tool.exe`) is resolved as given, relative to the working directory.
 * Node itself only tries .com and .exe, which is why a .cmd shim like `npm` or `queue` needs this.
 */
export function findWindowsProgram(program: string, cwd: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const base = cwd ?? process.cwd();
  const extensions = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '');
  const known = extensions.map((e) => e.toLowerCase());
  const hasExtension = known.includes(extname(program).toLowerCase());
  const names = hasExtension ? [program, ...extensions.map((e) => program + e)] : extensions.map((e) => program + e);
  const hasDirectory = /[\\/:]/.test(program);
  const directories = hasDirectory || isAbsolute(program) ? [''] : pathDirectories(env);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory === '' ? resolve(base, name) : resolve(base, directory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}
