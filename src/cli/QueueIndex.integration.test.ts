import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

describe('queue cli self-check (integration)', () => {
  it('produces output only on stderr — no duplicate lines on stdout', () => {
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

  it('queue start → status running → stop → status not running', async () => {
    // Ensure clean state
    runCli(['stop']);

    const start = runCli(['start']);
    expect(start.exitCode, `start stderr: ${start.stderr}`).toBe(0);
    expect(start.stderr).toContain('[ok] daemon started');

    // status is non-TTY → outputs JSON
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
    const entries = JSON.parse(stdout) as Array<{ event: string; totalCount: number; matchedCount: number; subscribers: Array<{ status: string }> }>;

    expect(entries).toHaveLength(1);
    const [entry] = entries;
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
    const entries = JSON.parse(stdout) as unknown[];
    expect(entries.length).toBeGreaterThan(0);
  });

  it('records a trigger-only entry when no subscriber is configured for the event', async () => {
    runCli(['push', 'unconfigured.history.integration.event', '{}']);
    await new Promise(resolve => setTimeout(resolve, 300));

    const { stdout } = runCli(['history', '--event', 'unconfigured.history.integration.event', '--json']);
    const entries = JSON.parse(stdout) as Array<{ totalCount: number; matchedCount: number; subscribers: unknown[] }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ totalCount: 0, matchedCount: 0, subscribers: [] });
  }, 15_000);
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

    const originalEntries = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as Array<{ eventId: string; payload?: { marker?: string } }>;
    const original = originalEntries.find(e => e.payload?.marker === 'replay-me');
    expect(original).toBeDefined();

    const replay = runCli(['replay', original!.eventId]);
    expect(replay.exitCode, `stderr: ${replay.stderr}`).toBe(0);
    expect(replay.stdout).toMatch(/replayed/);

    await new Promise(resolve => setTimeout(resolve, 500));

    const allEntries = JSON.parse(runCli(['history', '--event', event, '--json']).stdout) as Array<{ eventId: string; replayOf?: string; payload?: unknown }>;
    const replayed = allEntries.find(e => e.replayOf === original!.eventId);
    expect(replayed).toBeDefined();
    expect(replayed!.payload).toEqual({ marker: 'replay-me' });
  }, 15_000);

  it('fails with an actionable error for an unknown eventId', () => {
    const { exitCode, stderr } = runCli(['replay', 'does-not-exist-eventid']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No history entry found/);
  });
});
