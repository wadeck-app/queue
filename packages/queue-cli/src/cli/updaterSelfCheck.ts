import { join } from 'node:path';

export interface SelfCheckDeps {
  pkgName: string;
  execPath: string;
  /** Runs npm with these arguments and returns its stdout; throws when npm fails. */
  execNpm: (args: string[]) => string;
  /** The environment shared-updater reads UPDATER_SELF_CHECK_CMD from; written to. */
  env: Record<string, string | undefined>;
}

export interface SelfCheckSetup {
  npmRoot?: string;
  /** Set when the check cannot run: the caller shows it (stderr and the update log). */
  warning?: string;
}

/**
 * Sets UPDATER_SELF_CHECK_CMD so shared-updater verifies the install after an upgrade. When `npm root -g` fails the update proceeds without that
 * verification: the warning says so at that point (and a broken install will not be rolled back).
 */
export function prepareSelfCheck(deps: SelfCheckDeps): SelfCheckSetup {
  let npmRoot: string;
  try {
    npmRoot = deps.execNpm(['root', '-g']).trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      warning: `the post-install self-check is skipped, so a broken install will NOT be rolled back automatically: "npm root -g" failed: ${reason}. Fix: make npm work in this environment, then run 'queue cli self-check' after the update.`,
    };
  }
  if (!deps.env['UPDATER_SELF_CHECK_CMD']) {
    deps.env['UPDATER_SELF_CHECK_CMD'] = `${deps.execPath} ${join(npmRoot, deps.pkgName, 'queue.cjs')} cli self-check`;
  }
  return { npmRoot };
}
