import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED,
  findLeaks,
  formatLeakMessage,
  prefixOf,
  REAL_TMPDIR_ENV,
  RUN_ROOT_MARKER,
  RUN_ROOT_PREFIX,
  startLeakGuard,
  sweepStaleRunRoots,
} from './tempLeakGuard.js';

const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// This file is itself guarded: what it creates is removed here, in a hook that runs whether the test passed or failed
const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'queue-leakguard-test-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) {
    removeTree(dir);
  }
});

describe('findLeaks', () => {
  it('reports the queue-* entries (directories and files), sorted, and nothing else', () => {
    const root = scratch();
    mkdirSync(join(root, 'queue-b-aB3dE9'));
    mkdirSync(join(root, 'queue-a-xY12zq'));
    writeFileSync(join(root, 'queue-file.txt'), 'x');
    mkdirSync(join(root, 'tsx'));
    mkdirSync(join(root, 'node-compile-cache'));
    mkdirSync(join(root, 'not-queue-a'));
    expect(findLeaks(root)).toEqual(['queue-a-xY12zq', 'queue-b-aB3dE9', 'queue-file.txt']);
  });

  it('is empty for a clean root', () => {
    const root = scratch();
    mkdirSync(join(root, 'tsx'));
    expect(findLeaks(root)).toEqual([]);
  });

  it('does not report the folder the product creates on purpose for the short unix socket paths', () => {
    const root = scratch();
    mkdirSync(join(root, 'queue-wait-1000'));
    mkdirSync(join(root, 'queue-wait-user'));
    expect(ALLOWED.every((allowed) => allowed.reason.length > 0)).toBe(true);
    expect(findLeaks(root)).toEqual([]);
  });

  it('still reports a test directory whose name only resembles an allowed one', () => {
    const root = scratch();
    mkdirSync(join(root, 'queue-wait-event-aB3dE9'));
    mkdirSync(join(root, 'queue-wait-1000', 'inner'), { recursive: true });
    expect(findLeaks(root)).toEqual(['queue-wait-event-aB3dE9']);
  });

  it('fails when the root does not exist: a guard that watches nothing must not pass', () => {
    const root = join(scratch(), 'missing');
    expect(() => findLeaks(root)).toThrow(/does not exist/);
  });
});

describe('prefixOf', () => {
  it.each([
    ['queue-sdk-it-config-aB3dE9', 'queue-sdk-it-config'],
    ['queue-relay-backoff-test-39cd2e08-9823-48b3-9fac-25747c528892', 'queue-relay-backoff-test'],
    ['queue-test-iso-Zz09aa', 'queue-test-iso'],
  ])('%s -> %s', (name, prefix) => {
    expect(prefixOf(name)).toBe(prefix);
  });
});

describe('formatLeakMessage', () => {
  it('names the package, the count per prefix and the fix', () => {
    const message = formatLeakMessage('/tmp/qrun-x', ['queue-a-aaaaaa', 'queue-a-bbbbbb', 'queue-b-cccccc'], 'queue-core');
    expect(message).toContain('queue-core');
    expect(message).toContain('left 3 temporary entries');
    expect(message).toContain('queue-a (2)');
    expect(message).toContain('queue-b (1)');
    expect(message).toContain('afterEach');
    expect(message).toContain('Fix:');
  });

  it('uses the singular for one entry', () => {
    expect(formatLeakMessage('/tmp/qrun-x', ['queue-a-aaaaaa'], 'p')).toContain('left 1 temporary entry');
  });
});

describe('startLeakGuard', () => {
  it('points TMPDIR, TEMP and TMP to a private root, reports what was left in it, removes it and restores the environment', () => {
    const realTmp = scratch();
    const env: NodeJS.ProcessEnv = { TMPDIR: '/before/tmpdir', TEMP: undefined, TMP: '/before/tmp', OTHER: 'kept' };
    const run = startLeakGuard(realTmp, env);
    expect(run.root.startsWith(join(realTmp, RUN_ROOT_PREFIX))).toBe(true);
    expect(env['TMPDIR']).toBe(run.root);
    expect(env['TEMP']).toBe(run.root);
    expect(env['TMP']).toBe(run.root);
    expect(existsSync(join(run.root, RUN_ROOT_MARKER))).toBe(true);
    mkdirSync(join(run.root, 'queue-leaked-aB3dE9'));
    expect(run.finish()).toEqual(['queue-leaked-aB3dE9']);
    expect(existsSync(run.root)).toBe(false);
    expect(env['TMPDIR']).toBe('/before/tmpdir');
    expect('TEMP' in env).toBe(false);
    expect(env['TMP']).toBe('/before/tmp');
    expect(env['OTHER']).toBe('kept');
  });

  it('hands the real temp dir to the tests that must not run inside the private root (QUEUE_TEST_REAL_TMPDIR), and takes it away at the end', () => {
    const realTmp = scratch();
    const env: NodeJS.ProcessEnv = {};
    const run = startLeakGuard(realTmp, env);
    expect(env[REAL_TMPDIR_ENV]).toBe(realTmp);
    run.finish();
    expect(REAL_TMPDIR_ENV in env).toBe(false);
  });

  it('restores a QUEUE_TEST_REAL_TMPDIR that was set before the run', () => {
    const realTmp = scratch();
    const env: NodeJS.ProcessEnv = { [REAL_TMPDIR_ENV]: '/set/before' };
    const run = startLeakGuard(realTmp, env);
    expect(env[REAL_TMPDIR_ENV]).toBe(realTmp);
    run.finish();
    expect(env[REAL_TMPDIR_ENV]).toBe('/set/before');
  });

  it('reports nothing for a run that removed everything it created', () => {
    const realTmp = scratch();
    const run = startLeakGuard(realTmp, {});
    const dir = mkdtempSync(join(run.root, 'queue-cleaned-'));
    rmSync(dir, { recursive: true });
    expect(run.finish()).toEqual([]);
  });

  it('ignores what other runs and other tools leave in the real temp dir, and removes only its own root', () => {
    const realTmp = scratch();
    mkdirSync(join(realTmp, 'queue-someone-else-aB3dE9'));
    const other = startLeakGuard(realTmp, {});
    const run = startLeakGuard(realTmp, {});
    mkdirSync(join(other.root, 'queue-other-run-leak-aB3dE9'));
    expect(run.finish()).toEqual([]);
    expect(existsSync(other.root)).toBe(true);
    expect(existsSync(join(realTmp, 'queue-someone-else-aB3dE9'))).toBe(true);
    expect(other.finish()).toEqual(['queue-other-run-leak-aB3dE9']);
  });

  it('refuses to finish twice', () => {
    const run = startLeakGuard(scratch(), {});
    run.finish();
    expect(() => run.finish()).toThrow(/twice/);
  });
});

describe('sweepStaleRunRoots', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function runRoot(realTmp: string, name: string, ageMs: number, marker = true): string {
    const path = join(realTmp, name);
    mkdirSync(path);
    if (marker) {
      writeFileSync(join(path, RUN_ROOT_MARKER), '1\n');
    }
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it('removes the old roots of killed runs, keeps recent ones, and never touches a directory without the marker or with another name', () => {
    const realTmp = scratch();
    const old = runRoot(realTmp, `${RUN_ROOT_PREFIX}old111`, 3 * DAY);
    const recent = runRoot(realTmp, `${RUN_ROOT_PREFIX}new222`, 1000);
    const foreign = runRoot(realTmp, `${RUN_ROOT_PREFIX}foreign`, 3 * DAY, false);
    const other = runRoot(realTmp, 'something-else', 3 * DAY);
    expect(sweepStaleRunRoots(realTmp)).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect([recent, foreign, other].map((path) => existsSync(path))).toEqual([true, true, true]);
  });

  it('does not follow a link named like a run root', () => {
    const realTmp = scratch();
    const target = runRoot(realTmp, 'target-dir', 3 * DAY);
    try {
      symlinkSync(target, join(realTmp, `${RUN_ROOT_PREFIX}link111`), 'junction');
    } catch (err) {
      throw new Error(`Cannot create a link in the temp dir, the test cannot check that links are never followed: ${String(err)}`);
    }
    expect(sweepStaleRunRoots(realTmp)).toEqual([]);
    expect(existsSync(join(target, RUN_ROOT_MARKER))).toBe(true);
  });

  it('judges the age with the injected clock', () => {
    const realTmp = scratch();
    const path = runRoot(realTmp, `${RUN_ROOT_PREFIX}old333`, 0);
    expect(sweepStaleRunRoots(realTmp)).toEqual([]);
    expect(sweepStaleRunRoots(realTmp, { now: () => Date.now() + 5 * DAY })).toEqual([path]);
  });
});

// The whole chain: a real vitest run of a throwaway project that uses the real globalSetup
describe('the globalSetup, in a real vitest run', () => {
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const vitestEntry = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const globalSetup = join(repoRoot, 'test-support', 'leakGuard.globalSetup.ts').replaceAll('\\', '/');

  function runProject(testSource: string, extraFiles: Record<string, string> = {}): { status: number | null; output: string } {
    const project = scratch();
    writeFileSync(
      join(project, 'vitest.config.mjs'),
      `export default { test: { globals: true, include: ['*.test.mjs'], globalSetup: [${JSON.stringify(globalSetup)}] } };\n`
    );
    writeFileSync(join(project, 'fixture.test.mjs'), testSource);
    for (const [name, content] of Object.entries(extraFiles)) {
      writeFileSync(join(project, name), content);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      // A nested run must not believe it is a worker of this one
      if (!key.toUpperCase().startsWith('VITEST') && key !== 'NODE_OPTIONS') {
        env[key] = value;
      }
    }
    const result = spawnSync(process.execPath, [vitestEntry, 'run', '--root', project], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 280_000 });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  // A test body that creates a directory in the temp dir and never removes it
  const LEAK_SOURCE = `import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nit('leaks', () => { mkdtempSync(join(tmpdir(), 'queue-fixture-leak-')); });\n`;

  it('fails the run, naming the leaked directory, when a test leaves one in the temp dir', () => {
    const { status, output } = runProject(
      `import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nit('leaks', () => { mkdtempSync(join(tmpdir(), 'queue-fixture-leak-')); });\n`
    );
    expect(output).toContain('1 passed');
    expect(output).toContain('queue-fixture-leak (1)');
    expect(status).not.toBe(0);
  });

  it('passes when the test removes what it created', () => {
    const { status, output } = runProject(
      `import { mkdtempSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nit('cleans', () => { const dir = mkdtempSync(join(tmpdir(), 'queue-fixture-clean-')); rmSync(dir, { recursive: true }); });\n`
    );
    expect(output).toContain('1 passed');
    expect(output).not.toContain('left ');
    expect(status).toBe(0);
  });

  it('counts a leak made by a process the test spawned (a daemon, a bundle), not only by the test itself', () => {
    const { status, output } = runProject(
      `import { execFileSync } from 'node:child_process';\nit('spawns', () => { execFileSync(process.execPath, [process.cwd() + '/child.mjs']); });\n`,
      { 'child.mjs': `import { mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nmkdtempSync(join(tmpdir(), 'queue-fixture-child-'));\n` }
    );
    expect(output).toContain('queue-fixture-child (1)');
    expect(status).not.toBe(0);
  });

  it('leaves no private root behind, leaking or not (a nested run creates its root in the temp dir of this one)', () => {
    runProject(`it('nothing', () => {});\n`);
    runProject(LEAK_SOURCE);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(RUN_ROOT_PREFIX))).toEqual([]);
  });
});

// A package added later, or a config edited, must not silently drop the guard
describe('the wiring of the packages', () => {
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const packagesDir = join(repoRoot, 'packages');
  const configs = readdirSync(packagesDir)
    .map((name) => ({ name, file: join(packagesDir, name, 'vitest.config.ts') }))
    .filter(({ file }) => existsSync(file));

  it('finds the packages that have tests (a rename of the folder layout must not make the next tests pass for nothing)', () => {
    expect(configs.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['queue-sdk', 'queue-core', 'queue-cli', 'queue-relay-client', 'plugin-github', 'plugin-gitlab', 'plugin-agent-wake', 'app-module-queue'])
    );
  });

  it.each(configs.map(({ name, file }) => [name, file]))('%s runs the leak guard', (_name, file) => {
    const source = readFileSync(file as string, 'utf8');
    expect(source, `${file} must list ../../test-support/leakGuard.globalSetup.ts in test.globalSetup`).toContain('../../test-support/leakGuard.globalSetup.ts');
  });

  it('queue-cli lists the guard LAST: its own global setup builds the bundle and takes the shared build lock in the real temp dir first', () => {
    const source = readFileSync(join(packagesDir, 'queue-cli', 'vitest.config.ts'), 'utf8');
    const list = /globalSetup:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const entries = list.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    expect(entries.at(-1)).toContain('leakGuard.globalSetup.ts');
    expect(entries.length).toBeGreaterThan(1);
  });
});
