// Builds the bundled CLI once per vitest run, into a directory of its own (see src/testing/testBundle.ts).
//
// Why not dist-bundle/: the integration test files used to rebuild it each in its own beforeAll. Run in parallel (or by two sessions on the
// same checkout) they would overwrite queue.cjs / app-module/ while another file's daemon was loading them. The build also writes
// ../app-module-queue/dist-module, which is shared by every run on this checkout: a lock directory in the OS temp dir serialises
// the builds of concurrent runs (a lock whose owner process is gone is taken over).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BUNDLE_DIR_ENV } from './src/testing/testBundle.js';

const packageDir = dirname(fileURLToPath(import.meta.url));
const LOCK_DIR = join(tmpdir(), 'queue-cli-tests-bundle.lock');
const POLL_MS = 250;
// Hang guard only, never a performance limit: a build takes seconds, another run's build can queue ahead of ours
const LOCK_WAIT_MS = 300_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as { pid?: unknown };
    return typeof owner.pid === 'number' ? owner.pid : undefined;
  } catch {
    return undefined;
  }
}

async function acquireBuildLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
    const owner = readLockOwner();
    // No owner file yet means the owner is between mkdir and writeFile: give it a moment instead of stealing the lock
    if (owner !== undefined && !isProcessAlive(owner)) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another test run (pid ${owner ?? 'unknown'}) has been building the test bundle for more than ${LOCK_WAIT_MS / 1000} s (lock: ${LOCK_DIR}). Fix: stop that run, or delete the lock directory if its owner is gone.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function releaseBuildLock(): void {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

export default async function setup(): Promise<() => void> {
  const outDir = mkdtempSync(join(tmpdir(), 'queue-cli-tests-bundle-'));
  await acquireBuildLock();
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
      cwd: packageDir,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration', BUNDLE_OUT_DIR: outDir },
    });
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    const e = err as { message: string; stdout?: string; stderr?: string };
    throw new Error(`Building the test bundle into ${outDir} failed: ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  } finally {
    releaseBuildLock();
  }
  if (!existsSync(join(outDir, 'queue.cjs'))) {
    throw new Error(`The test bundle build produced no queue.cjs in ${outDir}.`);
  }
  // Safety net for daemons started in a test process (not through createIsolatedCliEnv): app-core registration falls back to a pickup file in
  // APP_CORE_CONFIG_DIR (APP_CORE_PORT is 1 in vitest.config.ts), which must be a directory of this run, not ~/.config/app-core
  const appCoreDir = mkdtempSync(join(tmpdir(), 'queue-cli-tests-app-core-'));
  // Inherited by the test workers, which are started after the global setup
  process.env[TEST_BUNDLE_DIR_ENV] = outDir;
  process.env['APP_CORE_CONFIG_DIR'] = appCoreDir;
  return () => {
    rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(appCoreDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
}
