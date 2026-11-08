// Leak guard for the temporary directories of the test suites (shared by every package through vitest.config.ts `globalSetup`, see leakGuard.globalSetup.ts).
//
// Design: the guard cannot compare "the temp dir before and after" (another vitest run, another session or any other tool writes there at the same time and
// would make it fail for nothing). Instead each run gets a private temp root, and everything the run creates, in the test processes AND in the processes they
// spawn (daemons, bundles), lands in it because TMPDIR / TEMP / TMP point to it for the whole run. What is left in it when the run ends was created by this
// run and not removed: that is a leak, by construction, whatever the name or the way it was created.
//
// Not a package: no import from or to a package (queue-sdk is published and stays free of test code).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefix of the private root. Deliberately short: product code derives unix socket paths from the temp dir (`<tmpdir>/queue-wait-<uid>/...sock`, 104 bytes
 * at most on macOS) and a longer root would push the wake of a wait over that limit in the tests.
 */
export const RUN_ROOT_PREFIX = 'qrun-';

/** File written in the private root: only a directory holding it is ever swept as stale, so a foreign directory that looks alike is never touched. */
export const RUN_ROOT_MARKER = '.queue-test-run';

/** What the repository's tests name their directories. Other entries of the private root (tool caches such as `tsx`, `node-compile-cache`) are not ours to judge. */
export const TRACKED_NAME = /^queue-/;

/**
 * Entries that start with `queue-` and are NOT leaks of a test: created by the product code itself, in the temp dir, on purpose.
 * Adding a pattern here needs a reason; a leaking test is fixed, never listed.
 *
 * The bundle build directory and the app-core pickup directory of queue-cli (`queue-cli-tests-*`), their build lock and the stale sweep are not listed:
 * vitest.globalSetup.ts of queue-cli creates them BEFORE this guard redirects the temp dir (the guard is the last entry of `globalSetup`), in the real
 * temp dir, and removes them itself.
 */
export const ALLOWED: readonly { pattern: RegExp; reason: string }[] = [
  {
    // The uid (or "user" when there is none), nothing else: a test directory called queue-wait-event-xxxxxx is a leak
    pattern: /^queue-wait-(\d+|user)$/,
    reason: 'per-user folder of the short unix socket paths of `queue wait` (WaiterWake.ts), created on purpose by the product when the config dir is too deep for a socket path',
  },
];

/** A run root left by a killed run (its teardown never ran) is removed by the next run once it is this old. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const SCOPED_ENV = ['TMPDIR', 'TEMP', 'TMP'] as const;

function remove(path: string): void {
  // Windows keeps files open for a moment after a process ended
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Removes the private root, the marker last: a process that outlives the run can create something in it while it is removed (observed once: the server
 * of a test still shutting down), and the root that is left must stay recognisable for the stale sweep of the next run. Never throws: the tests have
 * run, the leaks are reported by the caller, and a stuck directory is only worth a message.
 */
function removeRunRoot(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      if (name !== RUN_ROOT_MARKER) {
        remove(join(root, name));
      }
    }
    remove(root);
  } catch (err) {
    console.warn(`Could not remove the temp dir of the test run ${root}: ${err instanceof Error ? err.message : String(err)}. A process started by a test may still use it; the next run removes it once it is a day old. Fix: delete it by hand.`);
  }
}

/** The entries of `root` that a test created and did not remove. A missing `root` is an error: a guard that watches nothing must not pass. */
export function findLeaks(root: string): string[] {
  if (!existsSync(root)) {
    throw new Error(`The leak guard cannot read its private temp root ${root}: it does not exist. Something removed it during the run; do not delete the temp dir while the tests run.`);
  }
  return readdirSync(root)
    .filter((name) => TRACKED_NAME.test(name) && !ALLOWED.some((allowed) => allowed.pattern.test(name)))
    .sort();
}

/** Strips the random suffix `mkdtemp` appends (six characters) or the UUID some tests append: `queue-sdk-it-config-aB3dE9` -> `queue-sdk-it-config`. */
export function prefixOf(name: string): string {
  return name.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '').replace(/-[A-Za-z0-9]{6}$/, '');
}

export function formatLeakMessage(root: string, leaks: readonly string[], packageName: string): string {
  const byPrefix = new Map<string, number>();
  for (const name of leaks) {
    byPrefix.set(prefixOf(name), (byPrefix.get(prefixOf(name)) ?? 0) + 1);
  }
  const summary = [...byPrefix].map(([prefix, count]) => `  ${prefix} (${count})`).join('\n');
  return [
    `The test run of ${packageName} left ${leaks.length} temporary ${leaks.length === 1 ? 'entry' : 'entries'} named queue-* in its temp dir (${root}); they have been removed:`,
    summary,
    'Every test removes what it creates, whether it passes or fails: afterEach / afterAll or try / finally with',
    'rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), after stopping any daemon or process that uses the directory.',
    'Fix: search the test sources for the prefix above (mkdtemp / tmpdir) and make its cleanup unconditional. See .claude/guiding-principles.md ("Tests remove their temporary directories").',
  ].join('\n');
}

/** Removes the run roots of killed runs: marker present, a real directory (never a link), untouched for more than `maxAgeMs`. Returns the removed paths. */
export function sweepStaleRunRoots(realTmp: string, options: { now?: () => number; maxAgeMs?: number; warn?: (message: string) => void } = {}): string[] {
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? STALE_AFTER_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const removed: string[] = [];
  for (const name of readdirSync(realTmp)) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) {
      continue;
    }
    const path = join(realTmp, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs <= maxAgeMs || !existsSync(join(path, RUN_ROOT_MARKER))) {
        continue;
      }
      remove(path);
      removed.push(path);
    } catch (err) {
      warn(`Could not remove the stale test run directory ${path}: ${err instanceof Error ? err.message : String(err)}. Fix: delete it by hand.`);
    }
  }
  return removed;
}

export interface LeakGuardRun {
  /** The private temp root of this run. */
  root: string;
  /** Restores the environment, removes the private root and returns what was left in it. Call once. */
  finish(): string[];
}

/**
 * Creates the private root under `realTmp` and points TMPDIR / TEMP / TMP of `env` (process.env by default) to it: every process started afterwards
 * (vitest workers, the daemons and bundles the tests spawn) inherits it, and so does `os.tmpdir()`.
 */
export function startLeakGuard(realTmp: string = tmpdir(), env: NodeJS.ProcessEnv = process.env): LeakGuardRun {
  mkdirSync(realTmp, { recursive: true });
  const root = mkdtempSync(join(realTmp, RUN_ROOT_PREFIX));
  writeFileSync(join(root, RUN_ROOT_MARKER), `${process.pid}\n`);
  const previous = SCOPED_ENV.map((key) => [key, env[key]] as const);
  for (const key of SCOPED_ENV) {
    env[key] = root;
  }
  let finished = false;
  return {
    root,
    finish(): string[] {
      if (finished) {
        throw new Error('LeakGuardRun.finish() was called twice.');
      }
      finished = true;
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      try {
        return findLeaks(root);
      } finally {
        removeRunRoot(root);
      }
    },
  };
}
