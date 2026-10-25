import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { spawnOwned, waitFor, removeDirWhenFree, withHangGuard } from '../testWaitFor.js';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const bundlePath = join(rootDir, 'dist-bundle/queue.cjs');

let tempConfigDir: string;
let iso: IsolatedCliEnv | undefined;

beforeAll(() => {
  // Build the bundle before running integration tests
  execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
    windowsHide: true,
  });

  // Throwaway config dir, home, npm prefix and unreachable registry: the spawned CLI must never touch the real machine state
  iso = createIsolatedCliEnv();
  tempConfigDir = iso.configDir;
});

afterAll(() => {
  iso?.cleanup();
});

function isolatedEnv(): NodeJS.ProcessEnv {
  if (!iso) {
    throw new Error('isolated CLI environment not initialised: beforeAll did not run');
  }
  return iso.env;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf-8',
    // Hang guard only, never a performance limit
    timeout: 300_000,
    env: {
      ...isolatedEnv(),
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

interface HistoryPageEntry {
  eventId: string;
  totalCount: number;
  matchedCount: number;
  subscribers: Array<{ status: string }>;
  replayOf?: string;
  cwd?: string;
  payload?: { marker?: string; source?: string };
}

// Waits until the daemon has recorded what the test pushed: the history entries of `event` satisfying `ready` (never a guessed delay)
async function waitForHistory(event: string, what: string, ready: (entries: HistoryPageEntry[]) => boolean): Promise<HistoryPageEntry[]> {
  return waitFor(() => {
    const { stdout } = runCli(['history', '--event', event, '--json']);
    if (stdout.trim() === '') {
      return undefined;
    }
    const entries = (JSON.parse(stdout) as { entries: HistoryPageEntry[] }).entries;
    return ready(entries) ? entries : undefined;
  }, what);
}

describe('bundled app-module manifest (integration)', () => {
  it('carries the build version, so app-core re-imports the backend after every update', () => {
    // app-core's loader imports `backend.cjs?v=<manifest.version>`; a constant version means the
    // import cache returns the previous backend after `queue cli update` (page= was silently ignored).
    const manifest = JSON.parse(readFileSync(join(rootDir, 'dist-bundle/app-module/manifest.json'), 'utf-8')) as { version: string };
    expect(manifest.version).toBe('0.0.0-test-integration');
  });

  it('is the module artifact built by app-core-cli package: packaged manifest, a callable backend, JSON views, no sources', () => {
    const appModuleDir = join(rootDir, 'dist-bundle/app-module');
    const manifest = JSON.parse(readFileSync(join(appModuleDir, 'manifest.json'), 'utf-8')) as { backendEntryPath: string; extensionPoints: { view: { value: string } }[] };
    expect(manifest.backendEntryPath).toBe('./api-backend/backend.cjs');
    for (const point of manifest.extensionPoints) {
      expect(point.view.value).toMatch(/^\.\/dsl-frontend\/[\w.-]+\.json$/);
      expect(existsSync(join(appModuleDir, point.view.value))).toBe(true);
    }
    // app-core's loader needs `default` to be the function itself: the packaged CJS bundle collapses module.exports
    const backend: unknown = createRequire(import.meta.url)(join(appModuleDir, manifest.backendEntryPath));
    expect(typeof backend).toBe('function');
    expect(existsSync(join(appModuleDir, 'src'))).toBe(false);
  });

  it('keeps the module id: app-core refuses a manifest without "id" (or with another one than the registration id)', () => {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'dist-bundle/app-module/manifest.json'), 'utf-8')) as { id?: string };
    expect(manifest.id).toBe('queue');
  });
});

describe('queue cli self-check (integration)', () => {
  it('produces output only on stderr - no duplicate lines on stdout', () => {
    const { stdout, stderr } = runCli(['cli', 'self-check']);

    // stderr should have [ok] or [fail] lines
    expect(stderr).toMatch(/\[ok\]|\[fail\]/);

    // stdout must be empty (self-check writes to stderr only)
    expect(stdout).toBe('');
  });

  it('exits 0 when version is valid and config dir is writable', () => {
    const { exitCode } = runCli(['cli', 'self-check']);
    expect(exitCode).toBe(0);
  });
});

describe('queue cli update (integration)', () => {
  it('refuses to update from the repo-built bundle: actionable message, exit 1, nothing journalled', () => {
    // The bundle is built with BUNDLE_VERSION=0.0.0-test-integration (not CalVer): a dev build must never run npm install -g
    const { stdout, stderr, exitCode } = runCli(['cli', 'update']);

    expect(stdout + stderr).toMatch(/refusing to update the global install of queue/);
    expect(exitCode).toBe(1);
    expect(existsSync(join(tempConfigDir, 'update-state.json'))).toBe(false);
  });

  it('the updater bundle itself refuses a dev build (exit 1 when forced, exit 0 in the background) and logs why', () => {
    const updaterPath = join(rootDir, 'dist-bundle/queue-updater.cjs');
    const forced = spawnSync(process.execPath, [updaterPath], { encoding: 'utf-8', timeout: 300_000, env: { ...isolatedEnv(), UPDATER_FORCE: '1' } });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toMatch(/refusing to update the global install of queue/);
    const background = spawnSync(process.execPath, [updaterPath], { encoding: 'utf-8', timeout: 300_000, env: isolatedEnv() });
    expect(background.status).toBe(0);
    expect(background.stderr).toMatch(/refusing to update the global install of queue/);
    expect(existsSync(join(tempConfigDir, 'update-state.json'))).toBe(false);
  });
});

describe('unknown top-level command (integration)', () => {
  it('exits with code 1 and prints an error message', () => {
    const { stderr, exitCode } = runCli(['foobar-unknown-cmd-xyz']);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown command/i);
    expect(stderr).toContain('foobar-unknown-cmd-xyz');
  });
});

describe('daemon lifecycle (integration)', () => {
  afterEach(() => {
    // Best-effort cleanup: stop daemon after each test
    runCli(['stop']);
  });

  it('queue start -> status running -> stop -> status not running', async () => {
    // Ensure clean state
    runCli(['stop']);

    const start = runCli(['start']);
    expect(start.exitCode, `start stderr: ${start.stderr}`).toBe(0);
    expect(start.stderr).toContain('[ok] daemon started');

    // status is non-TTY -> outputs JSON
    const statusRunning = JSON.parse(runCli(['status']).stdout);
    expect(statusRunning.daemonRunning).toBe(true);

    const stop = runCli(['stop']);
    expect(stop.exitCode, `stop stderr: ${stop.stderr}`).toBe(0);
    expect(stop.stdout).toContain('[ok] daemon stopped');

    const statusStopped = JSON.parse(runCli(['status']).stdout);
    expect(statusStopped.daemonRunning).toBe(false);
  });

  it('queue start twice shows already running', () => {
    runCli(['stop']); // ensure clean state
    runCli(['start']);

    const start2 = runCli(['start']);
    expect(start2.exitCode).toBe(0);
    expect(start2.stderr).toContain('[ok] daemon already running');

    runCli(['stop']);
  });
});

describe('queue history (integration)', () => {
  const event = 'onHistoryIntegration.test';

  beforeAll(() => {
    runCli(['sub', 'add', event, '--name', 'matched', '--type', 'cli', '--command', 'node -e "process.exit(0)"']);
    runCli(['sub', 'add', event, '--name', 'filtered', '--type', 'cli', '--command', 'node -e "process.exit(0)"', '--when', 'payload.skip=true']);
    runCli(['start']);
  });

  afterAll(() => {
    runCli(['stop']);
    runCli(['sub', 'remove', event, '--index', '1']);
    runCli(['sub', 'remove', event, '--index', '0']);
  });

  it('records a trigger with a matched subscriber and a filtered subscriber', async () => {
    runCli(['push', event, JSON.stringify({ skip: false })]);
    // The daemon is done with the event when both subscriber outcomes (success and filtered) are recorded
    await waitForHistory(event, 'the success and filtered outcomes in the history', (entries) =>
      entries.some((e) => e.subscribers.some((s) => s.status === 'success') && e.subscribers.some((s) => s.status === 'filtered')));

    const { stdout, exitCode } = runCli(['history', '--event', event, '--json']);
    expect(exitCode).toBe(0);
    const page = JSON.parse(stdout) as { entries: Array<{ event: string; totalCount: number; matchedCount: number; subscribers: Array<{ status: string }> }>; total: number };

    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(1);
    const [entry] = page.entries;
    expect(entry!.totalCount).toBe(2);
    expect(entry!.matchedCount).toBe(1);
    expect(entry!.subscribers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'success' }),
        expect.objectContaining({ status: 'filtered' }),
      ]),
    );
  });

  it('--status filtered narrows to events with a filtered subscriber', () => {
    const { stdout } = runCli(['history', '--event', event, '--status', 'filtered', '--json']);
    const page = JSON.parse(stdout) as { entries: unknown[] };
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it('--limit without value exits with error', () => {
    const { stderr, exitCode } = runCli(['history', '--limit']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] --limit requires a value');
  });

  it('--offset without value exits with error', () => {
    const { stderr, exitCode } = runCli(['history', '--offset']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] --offset requires a value');
  });

  it('records a trigger-only entry when no subscriber is configured for the event', async () => {
    runCli(['push', 'unconfigured.history.integration.event', '{}']);
    await waitForHistory('unconfigured.history.integration.event', 'the trigger-only entry in the history', (entries) => entries.length >= 1);

    const { stdout } = runCli(['history', '--event', 'unconfigured.history.integration.event', '--json']);
    const page = JSON.parse(stdout) as { entries: Array<{ totalCount: number; matchedCount: number; subscribers: unknown[] }> };
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ totalCount: 0, matchedCount: 0, subscribers: [] });
  });

  it('--offset with --follow exits 1 and reports error', async () => {
    // Note: this test uses a short timeout because --offset + --follow should exit immediately
    // without entering follow mode (which would hang waiting for SIGINT).
    const { stderr, exitCode, stdout } = runCli(['history', '--follow', '--offset', '5']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] --offset cannot be combined with --follow');
    // Should not print anything before exiting (no history entries, no follow message)
    expect(stdout).toBe('');
  });

  it('--follow with --limit 2 seeds 5 entries and prints only the 2 newest', async () => {
    // Create a test history directory with 5 pre-seeded entries
    const historyDir = join(tempConfigDir, 'history');
    mkdirSync(historyDir, { recursive: true });

    // Write history entries with different timestamps for test.follow event
    const entries = [
      { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'test.follow', project: 'queue', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T10:01:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'test.follow', project: 'queue', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T10:02:00.000Z', type: 'trigger', eventId: 'ev-3', event: 'test.follow', project: 'queue', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T10:03:00.000Z', type: 'trigger', eventId: 'ev-4', event: 'test.follow', project: 'queue', matchedCount: 0, totalCount: 0 },
      { ts: '2026-01-01T10:04:00.000Z', type: 'trigger', eventId: 'ev-5', event: 'test.follow', project: 'queue', matchedCount: 0, totalCount: 0 },
    ];
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(historyDir, '2026-01-01.ndjson'), content, 'utf-8');

    // Run history --follow --limit 2 --event test.follow. --follow blocks until SIGINT: we own the process, wait for the output that
    // proves the initial dump happened (the newest entry is printed last), then kill it to simulate ^C
    const follower = spawnOwned(process.execPath, [bundlePath, 'history', '--follow', '--limit', '2', '--event', 'test.follow'], {
      env: isolatedEnv(),
    });
    try {
      await waitFor(() => follower.stdout().includes('eventId ev-5') && follower.stderr().includes('Following'),
        'the initial dump of the newest entry and the "Following" line');
    } finally {
      follower.child.kill();
      await withHangGuard(follower.exited, 'the killed history --follow process to exit');
    }

    const stdout = follower.stdout();
    const stderr = follower.stderr();

    // The initial dump should show only ev-4 and ev-5 (the 2 newest)
    // Check for the eventId in the formatted output: eventId ev-4 and eventId ev-5
    expect(stdout).toContain('eventId ev-4');
    expect(stdout).toContain('eventId ev-5');

    // ev-1, ev-2, ev-3 should NOT be in stdout
    expect(stdout).not.toContain('eventId ev-1');
    expect(stdout).not.toContain('eventId ev-2');
    expect(stdout).not.toContain('eventId ev-3');

    // Should have the "Following" message on stderr
    expect(stderr).toContain('Following');
  });
});

describe('queue replay (integration)', () => {
  const event = 'onReplayIntegration.test';

  beforeAll(() => {
    runCli(['sub', 'add', event, '--name', 'notify', '--type', 'cli', '--command', 'node -e "process.exit(0)"']);
    runCli(['start']);
  });

  afterAll(() => {
    runCli(['stop']);
    runCli(['sub', 'remove', event, '--index', '0']);
  });

  it('replays a past event with its original payload under a new eventId, linked via replayOf', async () => {
    const pushResult = runCli(['push', event, JSON.stringify({ marker: 'replay-me' })]);
    expect(pushResult.exitCode).toBe(0);
    const originalEntries = await waitForHistory(event, 'the pushed event in the history', (entries) => entries.some((e) => e.payload?.marker === 'replay-me'));
    const original = originalEntries.find(e => e.payload?.marker === 'replay-me');
    expect(original).toBeDefined();

    const replay = runCli(['replay', original!.eventId]);
    expect(replay.exitCode, `stderr: ${replay.stderr}`).toBe(0);
    expect(replay.stdout).toMatch(/replayed/);

    const allEntries = await waitForHistory(event, 'the replayed event in the history', (entries) => entries.some((e) => e.replayOf === original!.eventId));
    const replayed = allEntries.find(e => e.replayOf === original!.eventId);
    expect(replayed).toBeDefined();
    expect(replayed!.payload).toEqual({ marker: 'replay-me' });
  });

  it('fails with an actionable error for an unknown eventId', () => {
    const { exitCode, stderr } = runCli(['replay', 'does-not-exist-eventid']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No history entry found/);
  });

  it('replays from the recorded cwd, not the current cwd', async () => {
    // Create two separate project directories
    const projectA = mkdtempSync(join(tmpdir(), 'queue-replay-cwd-A-'));
    const projectB = mkdtempSync(join(tmpdir(), 'queue-replay-cwd-B-'));

    try {
      // Guard: ensure projectA and projectB are actually different directories
      const normalizedA = projectA.toLowerCase().replace(/\\/g, '/');
      const normalizedB = projectB.toLowerCase().replace(/\\/g, '/');
      expect(normalizedA).not.toBe(normalizedB);

      // Set up a subscriber under projectA
      const resultSubA = spawnSync(process.execPath, [bundlePath, 'sub', 'add', event, '--name', 'from-project-a', '--type', 'cli', '--command', 'node -e "process.exit(0)"'], {
        encoding: 'utf-8',
        env: isolatedEnv(),
        cwd: projectA,
      });
      expect(resultSubA.status, `Failed to add subscriber: ${resultSubA.stderr}`).toBe(0);

      // Start the daemon
      runCli(['start']);

      // Push from projectA (recorded in history with cwd = projectA)
      const pushResult = spawnSync(process.execPath, [bundlePath, 'push', event, JSON.stringify({ source: 'projectA' })], {
        encoding: 'utf-8',
        env: isolatedEnv(),
        cwd: projectA,
      });
      expect(pushResult.status).toBe(0);

      // Find the original event in history
      const historyEntries = await waitForHistory(event, 'the event pushed from projectA in the history', (entries) => entries.some((e) => e.payload?.source === 'projectA'));
      const original = historyEntries.find(e => e.payload?.source === 'projectA');
      expect(original, 'original event with source=projectA not found in history').toBeDefined();
      expect(original!.cwd).toBeTruthy();
      // Normalize paths for comparison (handle Windows paths)
      const normalizedOriginalCwd = original!.cwd!.toLowerCase().replace(/\\/g, '/');
      const normalizedProjectA = projectA.toLowerCase().replace(/\\/g, '/');
      expect(normalizedOriginalCwd).toBe(normalizedProjectA);

      // Replay from projectB (different cwd)
      const replayResult = spawnSync(process.execPath, [bundlePath, 'replay', original!.eventId], {
        encoding: 'utf-8',
        env: isolatedEnv(),
        cwd: projectB, // Run from different directory
      });
      expect(replayResult.status, `Replay failed: ${replayResult.stderr}`).toBe(0);

      // Check that the replay event was recorded with cwd = projectA (the original), not projectB
      const entriesAfterReplay = await waitForHistory(event, 'the replayed event in the history', (entries) => entries.some((e) => e.replayOf === original!.eventId));
      const replayed = entriesAfterReplay.find(e => e.replayOf === original!.eventId);
      expect(replayed, `replayed event with replayOf=${original!.eventId} not found in history`).toBeDefined();
      expect(replayed!.replayOf).toBe(original!.eventId);
      expect(replayed!.cwd).toBeTruthy();
      // The replayed event should have the original projectA cwd, not projectB cwd
      const normalizedReplayedCwd = replayed!.cwd!.toLowerCase().replace(/\\/g, '/');
      expect(normalizedReplayedCwd).toBe(normalizedProjectA);
    } finally {
      runCli(['stop']);
      // the daemon must be gone before its directories are removed
      await waitFor(() => !existsSync(join(tempConfigDir, 'config.port')), 'the daemon of this test to remove its port file');
      await removeDirWhenFree(projectA);
      await removeDirWhenFree(projectB);
    }
  });
});

describe('queue relay start (integration)', () => {
  it('exits 1 and reports [fail] No relay.yml when relay.yml does not exist', () => {
    const { stderr, exitCode } = runCli(['relay', 'start']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] No relay.yml in');
    expect(stderr).toContain('Create it as');
  });

  it('exits 1 and reports validation error when relay.yml has invalid YAML', () => {
    // Write invalid YAML
    const relayYmlPath = join(tempConfigDir, 'relay.yml');
    writeFileSync(relayYmlPath, 'invalid: yaml: content:\nno: good');

    const { stderr, exitCode } = runCli(['relay', 'start']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail]');
    expect(stderr).not.toContain('[ok] relay client started');
  });
});

describe('queue relay stop (integration)', () => {
  it('exits 0 and writes [ok] relay client was not running when relay is not running', () => {
    // Ensure relay is not running by stopping it first
    runCli(['relay', 'stop']);

    // Now try to stop again - should be idempotent
    const { stderr, exitCode } = runCli(['relay', 'stop']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain('[ok] relay client was not running');
  });
});


describe('queue sub add (integration): the name is mandatory and unique per event', () => {
  const event = 'onSubAddName.test';

  it('fails with exit 1 when --name is missing, saying how to give one', () => {
    const result = runCli(['sub', 'add', event, '--type', 'cli', '--command', 'node -e "process.exit(0)"']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--name is required');
    expect(result.stderr).toContain('--name notify');
  });

  it('fails with exit 1 when the name is already used on that event, naming the file and the way to edit that subscriber', () => {
    const add = ['sub', 'add', event, '--name', 'dup', '--type', 'cli', '--command', 'node -e "process.exit(0)"'];
    expect(runCli(add).exitCode).toBe(0);
    const again = runCli(add);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain(`already has a subscriber named 'dup'`);
    expect(again.stderr).toContain('subscribers.yml');
    expect(again.stderr).toContain(`queue sub edit ${event} --name dup`);
  });
});
