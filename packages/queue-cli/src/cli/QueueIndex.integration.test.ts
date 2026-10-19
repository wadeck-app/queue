import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const bundlePath = join(rootDir, 'dist-bundle/queue.cjs');

let tempConfigDir: string;

beforeAll(() => {
  // Build the bundle before running integration tests
  execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
    timeout: 60_000,
    windowsHide: true,
  });

  tempConfigDir = mkdtempSync(join(tmpdir(), 'queue-integration-'));
}, 90_000);

afterAll(() => {
  if (tempConfigDir && existsSync(tempConfigDir)) {
    rmSync(tempConfigDir, { recursive: true, force: true });
  }
});

function runCli(args: string[], extraEnv: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: {
      ...process.env,
      QUEUE_CONFIG_DIR: tempConfigDir,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
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
  it('produces at least one line of output', () => {
    // Point LAUNCHER_BUNDLE_OVERRIDE to a temp dir where updater does NOT exist,
    // so the command exits quickly without attempting a real npm install.
    const fakeBundle = join(tempConfigDir, 'fake-queue.cjs');
    const { stdout, stderr, exitCode } = runCli(['cli', 'update'], {
      LAUNCHER_BUNDLE_OVERRIDE: fakeBundle,
    });

    const combined = stdout + stderr;
    // Must produce at least one line (e.g. "[fail] updater not found at: ...")
    expect(combined.trim().length).toBeGreaterThan(0);
    // Should exit non-zero since updater is not present
    expect(exitCode).toBe(1);
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
  }, 30_000);

  it('queue start twice shows already running', () => {
    runCli(['stop']); // ensure clean state
    runCli(['start']);

    const start2 = runCli(['start']);
    expect(start2.exitCode).toBe(0);
    expect(start2.stderr).toContain('[ok] daemon already running');

    runCli(['stop']);
  }, 30_000);
});

describe('queue history (integration)', () => {
  const event = 'onHistoryIntegration.test';

  beforeAll(() => {
    runCli(['sub', 'add', event, '--type', 'cli', '--command', 'node -e "process.exit(0)"']);
    runCli(['sub', 'add', event, '--type', 'cli', '--command', 'node -e "process.exit(0)"', '--when', 'payload.skip=true']);
    runCli(['start']);
  });

  afterAll(() => {
    runCli(['stop']);
    runCli(['sub', 'remove', event, '--index', '1']);
    runCli(['sub', 'remove', event, '--index', '0']);
  });

  it('records a trigger with a matched subscriber and a filtered subscriber', async () => {
    runCli(['push', event, JSON.stringify({ skip: false })]);
    await new Promise(resolve => setTimeout(resolve, 500));

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
  }, 15_000);

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
    await new Promise(resolve => setTimeout(resolve, 300));

    const { stdout } = runCli(['history', '--event', 'unconfigured.history.integration.event', '--json']);
    const page = JSON.parse(stdout) as { entries: Array<{ totalCount: number; matchedCount: number; subscribers: unknown[] }> };
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ totalCount: 0, matchedCount: 0, subscribers: [] });
  }, 15_000);

  it('--offset with --follow exits 1 and reports error', async () => {
    // Note: this test uses a short timeout because --offset + --follow should exit immediately
    // without entering follow mode (which would hang waiting for SIGINT).
    const { stderr, exitCode, stdout } = runCli(['history', '--follow', '--offset', '5']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] --offset cannot be combined with --follow');
    // Should not print anything before exiting (no history entries, no follow message)
    expect(stdout).toBe('');
  }, 5_000);

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

    // Run history --follow --limit 2 --event test.follow with a short timeout
    // Since --follow blocks on SIGINT, we use a timeout to simulate ^C
    const result = spawnSync(process.execPath, [bundlePath, 'history', '--follow', '--limit', '2', '--event', 'test.follow'], {
      encoding: 'utf-8',
      timeout: 1_000, // Kill after 1s (simulating SIGINT after initial dump)
      env: {
        ...process.env,
        QUEUE_CONFIG_DIR: tempConfigDir,
      },
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

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
    runCli(['sub', 'add', event, '--type', 'cli', '--command', 'node -e "process.exit(0)"']);
    runCli(['start']);
  });

  afterAll(() => {
    runCli(['stop']);
    runCli(['sub', 'remove', event, '--index', '0']);
  });

  it('replays a past event with its original payload under a new eventId, linked via replayOf', async () => {
    const pushResult = runCli(['push', event, JSON.stringify({ marker: 'replay-me' })]);
    expect(pushResult.exitCode).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 500));

    const originalPage = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as { entries: Array<{ eventId: string; payload?: { marker?: string } }> };
    const original = originalPage.entries.find(e => e.payload?.marker === 'replay-me');
    expect(original).toBeDefined();

    const replay = runCli(['replay', original!.eventId]);
    expect(replay.exitCode, `stderr: ${replay.stderr}`).toBe(0);
    expect(replay.stdout).toMatch(/replayed/);

    await new Promise(resolve => setTimeout(resolve, 500));

    const allPage = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as { entries: Array<{ eventId: string; replayOf?: string; payload?: unknown }> };
    const replayed = allPage.entries.find(e => e.replayOf === original!.eventId);
    expect(replayed).toBeDefined();
    expect(replayed!.payload).toEqual({ marker: 'replay-me' });
  }, 15_000);

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
      const resultSubA = spawnSync(process.execPath, [bundlePath, 'sub', 'add', event, '--type', 'cli', '--command', 'node -e "process.exit(0)"'], {
        encoding: 'utf-8',
        env: { ...process.env, QUEUE_CONFIG_DIR: tempConfigDir },
        cwd: projectA,
      });
      expect(resultSubA.status, `Failed to add subscriber: ${resultSubA.stderr}`).toBe(0);

      // Start the daemon
      runCli(['start']);

      // Push from projectA (recorded in history with cwd = projectA)
      const pushResult = spawnSync(process.execPath, [bundlePath, 'push', event, JSON.stringify({ source: 'projectA' })], {
        encoding: 'utf-8',
        env: { ...process.env, QUEUE_CONFIG_DIR: tempConfigDir },
        cwd: projectA,
      });
      expect(pushResult.status).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Find the original event in history
      const historyResult = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as { entries: Array<{ eventId: string; payload?: { source?: string }; cwd?: string }> };
      const original = historyResult.entries.find(e => e.payload?.source === 'projectA');
      expect(original, 'original event with source=projectA not found in history').toBeDefined();
      expect(original!.cwd).toBeTruthy();
      // Normalize paths for comparison (handle Windows paths)
      const normalizedOriginalCwd = original!.cwd!.toLowerCase().replace(/\\/g, '/');
      const normalizedProjectA = projectA.toLowerCase().replace(/\\/g, '/');
      expect(normalizedOriginalCwd).toBe(normalizedProjectA);

      // Replay from projectB (different cwd)
      const replayResult = spawnSync(process.execPath, [bundlePath, 'replay', original!.eventId], {
        encoding: 'utf-8',
        env: { ...process.env, QUEUE_CONFIG_DIR: tempConfigDir },
        cwd: projectB, // Run from different directory
      });
      expect(replayResult.status, `Replay failed: ${replayResult.stderr}`).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check that the replay event was recorded with cwd = projectA (the original), not projectB
      const historyAfterReplay = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as { entries: Array<{ eventId: string; replayOf?: string; cwd?: string }> };
      const replayed = historyAfterReplay.entries.find(e => e.replayOf === original!.eventId);
      expect(replayed, `replayed event with replayOf=${original!.eventId} not found in history`).toBeDefined();
      expect(replayed!.replayOf).toBe(original!.eventId);
      expect(replayed!.cwd).toBeTruthy();
      // The replayed event should have the original projectA cwd, not projectB cwd
      const normalizedReplayedCwd = replayed!.cwd!.toLowerCase().replace(/\\/g, '/');
      expect(normalizedReplayedCwd).toBe(normalizedProjectA);
    } finally {
      runCli(['stop']);
      rmSync(projectA, { recursive: true, force: true });
      rmSync(projectB, { recursive: true, force: true });
    }
  }, 20_000);
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

