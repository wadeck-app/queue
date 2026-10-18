import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RegisterAfterUpdateDeps {
  configDir: string;
  /** manifest.json of the app-module inside the freshly installed package. */
  manifestPath: string;
  /** When this updater run began: a state written before it belongs to an earlier run. */
  startedAtMs: number;
  register: (manifestPath: string, log: (entry: { source: string; message: string }) => void) => Promise<void>;
  log: (line: string) => void;
}

/**
 * After `queue cli update` installed a new version, a running app-core still holds the previous
 * module in memory (it reads the manifest only when it is told to). The daemon re-registers on its
 * own start, but the update does not restart it, so the updater tells app-core itself.
 * Only for a success written by THIS run: a failed or rolled-back update did not change the install,
 * and "already up to date" leaves an older success in the state file.
 */
export async function registerAfterUpdate(deps: RegisterAfterUpdateDeps): Promise<void> {
  const stateFile = join(deps.configDir, 'update-state.json');
  let state: { status?: string; timestamp?: number };
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as { status?: string; timestamp?: number };
  } catch (err) {
    // String(err), not queue-core's getErrorMessage: the updater bundle must not import the queue runtime.
    deps.log(`app-core: not re-registering the app-module, cannot read ${stateFile} (${String(err)})`);
    return;
  }
  if (state.status !== 'success' || (state.timestamp ?? 0) < deps.startedAtMs) {
    return;
  }
  await deps.register(deps.manifestPath, (entry) => deps.log(`app-core: ${entry.message}`));
}
