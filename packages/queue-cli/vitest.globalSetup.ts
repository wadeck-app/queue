// Builds the bundled CLI once per vitest run, into a directory of its own (see src/testing/testBundle.ts).
//
// Why not dist-bundle/: the integration test files used to rebuild it each in its own beforeAll. Run in parallel (or by two sessions on the
// same checkout) they would overwrite queue.cjs / app-module/ while another file's daemon was loading them. The build also writes
// ../app-module-queue/dist-module, which is shared by every run on this checkout: a lock directory in the OS temp dir serialises
// the builds of concurrent runs (a lock whose owner process is gone is taken over, see src/testing/buildLock.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BUNDLE_DIR_ENV } from './src/testing/testBundle.js';
import { acquireBuildLock, releaseBuildLock } from './src/testing/buildLock.js';
import { sweepStaleTestDirs } from './src/testing/staleSweep.js';

const packageDir = dirname(fileURLToPath(import.meta.url));
const LOCK_DIR = join(tmpdir(), 'queue-cli-tests-bundle.lock');

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export default async function setup(): Promise<() => void> {
  // The teardown below does not run when vitest is killed: remove what such runs left in the temp dir (only this tool's directories, older than a day)
  sweepStaleTestDirs({ root: tmpdir() });
  // The lock first: a run that gives up waiting for it (hang guard) must not leave a directory of its own behind
  await acquireBuildLock({ lockDir: LOCK_DIR });
  let locked = true;
  const created: string[] = [];
  try {
    const outDir = mkdtempSync(join(tmpdir(), 'queue-cli-tests-bundle-'));
    created.push(outDir);
    try {
      execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
        cwd: packageDir,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration', BUNDLE_OUT_DIR: outDir },
      });
    } catch (err) {
      const e = err as { message: string; stdout?: string; stderr?: string };
      throw new Error(`Building the test bundle into ${outDir} failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    }
    // The build is over: the next run may build
    releaseBuildLock(LOCK_DIR);
    locked = false;
    if (!existsSync(join(outDir, 'queue.cjs'))) {
      throw new Error(`The test bundle build produced no queue.cjs in ${outDir}.`);
    }
    // Safety net for daemons started in a test process (not through createIsolatedCliEnv): app-core registration falls back to a pickup file in
    // APP_CORE_CONFIG_DIR (APP_CORE_PORT is 1 in vitest.config.ts), which must be a directory of this run, not ~/.config/app-core
    const appCoreDir = mkdtempSync(join(tmpdir(), 'queue-cli-tests-app-core-'));
    created.push(appCoreDir);
    // Inherited by the test workers, which are started after the global setup
    process.env[TEST_BUNDLE_DIR_ENV] = outDir;
    process.env['APP_CORE_CONFIG_DIR'] = appCoreDir;
    return () => {
      removeTree(outDir);
      removeTree(appCoreDir);
    };
  } catch (err) {
    // Nobody calls the teardown of a setup that failed: release the lock if it is still ours and remove what this setup created
    if (locked) {
      releaseBuildLock(LOCK_DIR);
    }
    for (const dir of created) {
      removeTree(dir);
    }
    throw err;
  }
}
