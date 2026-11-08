// Removes the throwaway directories a killed vitest run left behind (its global teardown never ran): see vitest.globalSetup.ts.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Directories created by vitest.globalSetup.ts: `mkdtemp` appends exactly six characters of [A-Za-z0-9]. Nothing else is ever touched. */
export const STALE_DIR_PATTERN = /^queue-cli-tests-(bundle|app-core)-[A-Za-z0-9]{6}$/;

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** The directory to look in (the OS temp dir). */
  root: string;
  /** Test seam: the current time (ms). */
  now?: () => number;
  /** Test seam: age beyond which a directory is stale. */
  maxAgeMs?: number;
  /** Test seam: the removal of one directory. */
  remove?: (path: string) => void;
  /** Receives one message per directory that could not be removed (default: console.warn). A run still in progress may hold one open. */
  warn?: (message: string) => void;
}

/**
 * Removes the directories of `options.root` that match STALE_DIR_PATTERN, are real directories (a symbolic link or a junction is never followed
 * nor removed) and were last modified more than a day ago. Returns the removed paths.
 */
export function sweepStaleTestDirs(options: SweepOptions): string[] {
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? STALE_AFTER_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const removed: string[] = [];
  for (const name of readdirSync(options.root)) {
    if (!STALE_DIR_PATTERN.test(name)) {
      continue;
    }
    const path = join(options.root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= maxAgeMs) {
        continue;
      }
      remove(path);
      removed.push(path);
    } catch (err) {
      warn(`Could not remove the stale test directory ${path}: ${err instanceof Error ? err.message : String(err)}. Fix: delete it by hand.`);
    }
  }
  return removed;
}
