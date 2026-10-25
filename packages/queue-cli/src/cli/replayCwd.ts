import { existsSync } from 'node:fs';
import type { HistoryEntry } from '@wadeck-app/queue-core';

export type ReplayCwd = { ok: true; cwd: string } | { ok: false; message: string };

/**
 * The directory a replay runs in. It decides which subscribers fire (it selects the registered project, whose subscribers apply), so it is never
 * guessed: the one the user names with --cwd, else the one recorded with the event when it still exists, else a refusal that says how
 * to choose.
 *
 * @param explicitCwd The directory given with --cwd, if any
 * @param testExistsSync Optional fs.existsSync override for testing; defaults to real fs.existsSync
 */
export function resolveReplayCwd(
  entry: HistoryEntry,
  explicitCwd: string | undefined,
  testExistsSync: (path: string) => boolean = existsSync,
): ReplayCwd {
  if (explicitCwd !== undefined) {
    return testExistsSync(explicitCwd) ? { ok: true, cwd: explicitCwd } : { ok: false, message: `[fail] --cwd ${explicitCwd} does not exist: nothing was replayed.` };
  }
  if (entry.cwd && testExistsSync(entry.cwd)) {
    return { ok: true, cwd: entry.cwd };
  }
  const why = entry.cwd ? `its recorded working directory ${entry.cwd} no longer exists` : `History entry ${entry.eventId} has no recorded working directory`;
  return {
    ok: false,
    message:
      `[fail] ${entry.cwd ? `History entry ${entry.eventId}: ${why}` : why}, so the project it belongs to cannot be determined. ` +
      `The directory selects which subscribers run, so a replay never picks one for you: name it with "queue replay ${entry.eventId} --cwd <directory>" (the project directory, or any directory inside the registered project whose subscribers you want applied).`,
  };
}
