import { isCalVer } from './devBuildGuard.js';

/**
 * Builds the once-guarded "schedule the background self-update" function called from the
 * `finally` of a normal run.
 *
 * - Fires at most once per process.
 * - Never fires for a non-CalVer (repo-built / tsx) build: the spawned updater would otherwise be a
 *   mutating `npm install -g` from a dev checkout.
 */
export function createUpdateScheduler(opts: { version: string; schedule: () => void }): () => void {
  let done = false;
  return () => {
    if (done) {
      return;
    }
    done = true;
    if (!isCalVer(opts.version)) {
      return;
    }
    opts.schedule();
  };
}
