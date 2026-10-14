import { existsSync } from 'node:fs';
import type { HistoryEntry } from '@wadeck-app/queue-core';

/**
 * Pure function to resolve which working directory to use for CLI replay. Returns the recorded
 * cwd if it exists; otherwise falls back to currentCwd and includes a warning message
 * that should be printed to stderr.
 * @param entry History entry (may have cwd field)
 * @param currentCwd Current working directory to fall back to
 * @param testExistsSync Optional fs.existsSync override for testing; defaults to real fs.existsSync
 */
export function resolveReplayCwd(
  entry: HistoryEntry,
  currentCwd: string,
  testExistsSync: (path: string) => boolean = existsSync,
): { cwd: string; warning?: string } {
  if (entry.cwd && testExistsSync(entry.cwd)) {
    return { cwd: entry.cwd };
  }

  let why: string;
  if (!entry.cwd) {
    why = 'no recorded working directory';
  } else {
    why = `recorded working directory ${entry.cwd} no longer exists`;
  }

  return {
    cwd: currentCwd,
    warning: `[warn] History entry ${entry.eventId} has no usable recorded working directory (${why}); replaying with the current directory ${currentCwd}.`,
  };
}
