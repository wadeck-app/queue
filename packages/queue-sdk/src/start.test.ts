import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findQueueExecutable, runQueueStart, startDaemon, type StartDeps } from './start.js';
import { makeFakeQueue } from './testing/fakeQueue.js';
import { makeTempDir, removeDir } from './testing/fakeDaemon.js';

let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeDir(dir);
});

describe('findQueueExecutable (injected file system)', () => {
  const present = (...paths: string[]) => (path: string) => paths.includes(path);

  it('finds queue.cmd through PATHEXT on win32, first PATH entry wins', () => {
    const found = findQueueExecutable({ PATH: `${join('c', 'one')};${join('c', 'two')}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32', present(join('c', 'two', 'queue.CMD'), join('c', 'one', 'queue.BAT')));
    expect(found).toBe(join('c', 'one', 'queue.BAT'));
  });

  it('honours PATHEXT order inside one directory', () => {
    const found = findQueueExecutable({ PATH: 'bin', PATHEXT: '.EXE;.CMD' }, 'win32', present(join('bin', 'queue.CMD'), join('bin', 'queue.EXE')));
    expect(found).toBe(join('bin', 'queue.EXE'));
  });

  it('reads the Path variable whatever its case on win32', () => {
    expect(findQueueExecutable({ Path: 'bin', PATHEXT: '.CMD' }, 'win32', present(join('bin', 'queue.CMD')))).toBe(join('bin', 'queue.CMD'));
  });

  it('uses a default PATHEXT on win32 and ignores extensions that cannot be spawned', () => {
    expect(findQueueExecutable({ PATH: 'bin' }, 'win32', present(join('bin', 'queue.CMD')))).toBe(join('bin', 'queue.CMD'));
    expect(findQueueExecutable({ PATH: 'bin', PATHEXT: '.VBS;.JS' }, 'win32', present(join('bin', 'queue.VBS')))).toBeUndefined();
  });

  it('does not take an extension-less file on win32', () => {
    expect(findQueueExecutable({ PATH: 'bin', PATHEXT: '.CMD' }, 'win32', present(join('bin', 'queue')))).toBeUndefined();
  });

  it('finds the plain name on POSIX, splitting PATH on a colon', () => {
    const found = findQueueExecutable({ PATH: `${join('a')}:${join('b')}` }, 'linux', present(join('b', 'queue')));
    expect(found).toBe(join('b', 'queue'));
  });

  it('skips empty PATH entries and strips quotes', () => {
    expect(findQueueExecutable({ PATH: `;"bin";` , PATHEXT: '.CMD' }, 'win32', present(join('bin', 'queue.CMD')))).toBe(join('bin', 'queue.CMD'));
    expect(findQueueExecutable({ PATH: '::' }, 'linux', present('queue'))).toBeUndefined();
  });

  it('returns undefined without PATH or when nothing matches', () => {
    expect(findQueueExecutable({}, 'linux', present('queue'))).toBeUndefined();
    expect(findQueueExecutable({ PATH: 'bin' }, 'linux', present())).toBeUndefined();
  });
});

describe('findQueueExecutable (real file system)', () => {
  it('finds a real executable in a temp PATH entry', () => {
    const logFile = join(dir, 'log');
    const expected = makeFakeQueue(join(dir, 'bin'), { exitCode: 0, logFile });
    expect(findQueueExecutable({ PATH: `${join(dir, 'empty')}${delimiter}${join(dir, 'bin')}`, PATHEXT: process.env['PATHEXT'] ?? '.EXE;.CMD' })?.toLowerCase()).toBe(expected.toLowerCase());
  });

  it.skipIf(process.platform === 'win32')('ignores a file without the executable bit (POSIX only: Windows has no executable bit)', () => {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'queue'), '#!/bin/sh\n');
    chmodSync(join(dir, 'bin', 'queue'), 0o644);
    expect(findQueueExecutable({ PATH: join(dir, 'bin') })).toBeUndefined();
  });

  it('ignores a directory called queue', () => {
    mkdirSync(join(dir, 'bin', process.platform === 'win32' ? 'queue.cmd' : 'queue'), { recursive: true });
    expect(findQueueExecutable({ PATH: join(dir, 'bin'), PATHEXT: '.CMD' })).toBeUndefined();
  });
});

interface Harness {
  deps: StartDeps;
  runs: Array<{ executable: string; configDir: string }>;
  sleeps: number[];
}

function harness(options: { exe?: string | undefined; code?: number | null; error?: string; readyAfter?: number }): Harness {
  const runs: Harness['runs'] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let checks = 0;
  return {
    runs,
    sleeps,
    deps: {
      find: () => ('exe' in options ? options.exe : 'queue'),
      run: (executable, configDir) => {
        runs.push({ executable, configDir });
        return Promise.resolve({ code: 'code' in options ? (options.code as number | null) : 0, ...(options.error !== undefined && { error: options.error }) });
      },
      ready: () => {
        checks += 1;
        return Promise.resolve(options.readyAfter !== undefined && checks > options.readyAfter);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      pollIntervalMs: 100,
      timeoutMs: 1000,
    },
  };
}

describe('startDaemon', () => {
  it('reports queue as not installed without running anything', async () => {
    const h = harness({ exe: undefined });
    const result = await startDaemon('cfg', h.deps);
    expect(result).toMatchObject({ ok: false, kind: 'not-installed' });
    expect(!result.ok && result.reason).toContain('PATH');
    expect(!result.ok && result.reason).toContain('queue-cli');
    expect(h.runs).toHaveLength(0);
  });

  it('runs the executable once with the config dir, then succeeds when the daemon answers', async () => {
    const h = harness({ readyAfter: 0 });
    expect(await startDaemon('cfg', h.deps)).toEqual({ ok: true });
    expect(h.runs).toEqual([{ executable: 'queue', configDir: 'cfg' }]);
  });

  it('polls until the daemon answers', async () => {
    const h = harness({ readyAfter: 3 });
    expect(await startDaemon('cfg', h.deps)).toEqual({ ok: true });
    expect(h.sleeps).toEqual([100, 100, 100]);
  });

  it('gives up after the timeout and says so', async () => {
    const h = harness({});
    const result = await startDaemon('cfg', h.deps);
    expect(result).toMatchObject({ ok: false, kind: 'not-ready' });
    expect(!result.ok && result.reason).toContain('1000 ms');
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  it('reports a non-zero exit code', async () => {
    const h = harness({ code: 3 });
    const result = await startDaemon('cfg', h.deps);
    expect(result).toMatchObject({ ok: false, kind: 'start-failed', exitCode: 3 });
    expect(!result.ok && result.reason).toContain('exit code 3');
  });

  it('still succeeds when the daemon answers despite a non-zero exit (another start won the race)', async () => {
    const h = harness({ code: 1, readyAfter: 0 });
    expect(await startDaemon('cfg', h.deps)).toEqual({ ok: true });
  });

  it('reports a spawn error with its message', async () => {
    const h = harness({ code: null, error: 'spawn EINVAL' });
    const result = await startDaemon('cfg', h.deps);
    expect(result).toMatchObject({ ok: false, kind: 'start-failed' });
    expect(!result.ok && result.reason).toContain('spawn EINVAL');
  });
});

describe('runQueueStart (real process)', () => {
  it('runs the fake queue with the constant argument start and the config dir in the environment', async () => {
    const logFile = join(dir, 'log');
    const exe = makeFakeQueue(join(dir, 'bin'), { exitCode: 0, logFile });
    const result = await runQueueStart(exe, join(dir, 'cfg dir'));
    expect(result).toEqual({ code: 0 });
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('args=start');
    expect(log).toContain(`config=${join(dir, 'cfg dir')}`);
  });

  it('returns the exit code of the fake queue', async () => {
    const exe = makeFakeQueue(join(dir, 'bin'), { exitCode: 7, logFile: join(dir, 'log') });
    expect(await runQueueStart(exe, dir)).toEqual({ code: 7 });
  });

  it('works when the executable path contains a space', async () => {
    const logFile = join(dir, 'log');
    const exe = makeFakeQueue(join(dir, 'my bin'), { exitCode: 0, logFile });
    expect(await runQueueStart(exe, dir)).toEqual({ code: 0 });
  });

  it('reports an error for a missing executable instead of throwing', async () => {
    const result = await runQueueStart(join(dir, 'nope', process.platform === 'win32' ? 'queue.exe' : 'queue'), dir);
    expect(result.code === 0).toBe(false);
    expect(result.error ?? 'exit').toBeTruthy();
  });

  it.skipIf(process.platform !== 'win32')('refuses a .cmd path with shell metacharacters (Windows only: the shell is used only there)', async () => {
    const result = await runQueueStart(join(dir, 'bad%PATH%', 'queue.cmd'), dir);
    expect(result.code).toBeNull();
    expect(result.error).toContain('unsafe');
  });
});
