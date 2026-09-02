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
