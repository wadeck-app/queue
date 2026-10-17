/**
 * Integration test for `queue wait ci`: runs the bundled CLI against a throwaway config dir whose history
 * holds hand-written workflow_run records (same ndjson shape HistoryLog writes).
 * The live case (CI finishing while the command waits) is covered by the virtual-clock unit tests and by the manual end-to-end run.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');
const SHA = '9d9c4f7a36576a2c268e42d0c7b372e64b30ea19';

describe('queue wait ci (bundled CLI)', () => {
  let bundlePath: string;
  let configDir: string;

  beforeAll(() => {
    execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
      timeout: 60_000,
      windowsHide: true,
    });
    bundlePath = join(rootDir, 'dist-bundle/queue.cjs');
    if (!existsSync(bundlePath)) throw new Error(`Bundle not found at ${bundlePath}`);
  }, 90_000);

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-wait-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeRun(conclusion: string, name = 'CI / Publish', ageMs = 120_000): void {
    const historyDir = join(configDir, 'history');
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date(Date.now() - ageMs).toISOString();
    const record = {
      ts,
      type: 'trigger',
      eventId: `evt-${name}-${conclusion}`,
      event: 'on.github.workflow_run',
      matchedCount: 0,
      totalCount: 0,
      payload: {
        action: 'completed',
        workflow_run: { id: 7, name, head_sha: SHA, run_attempt: 1, status: 'completed', conclusion, html_url: 'https://github.com/o/r/actions/runs/7' },
        repository: { full_name: 'o/r' },
      },
    };
    writeFileSync(join(historyDir, `${ts.slice(0, 10)}.ndjson`), JSON.stringify(record) + '\n', { flag: 'a' });
  }

  // Asynchronous spawn with an explicit timeout: a hang must fail the test, not freeze the suite
  function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env: NodeJS.ProcessEnv = { ...process.env, QUEUE_CONFIG_DIR: configDir };
    delete env['NODE_OPTIONS'];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundlePath, ...args], { cwd: configDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not finish within 30s: ${args.join(' ')}\n${stderr}`)); }, 30_000);
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });
  }

  it('exits 0 and lists the runs when the CI finished before the command started', async () => {
    writeRun('success');
    const result = await run(['wait', 'ci', SHA, '--repo', 'o/r', '--settle', '1s']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('CI passed');
    expect(result.stdout).toContain('CI / Publish');
    expect(result.stdout).toContain('https://github.com/o/r/actions/runs/7');
  });

  it('accepts an abbreviated SHA', async () => {
    writeRun('success');
    const result = await run(['wait', 'ci', SHA.slice(0, 7), '--repo', 'o/r', '--settle', '1s']);
    expect(result.exitCode).toBe(0);
  });

  it('exits 1 and names the failing workflow', async () => {
    writeRun('failure');
    const result = await run(['wait', 'ci', SHA, '--repo', 'o/r', '--settle', '1s']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAILED');
    expect(result.stdout).toContain('failure');
  });

  it('prints a parseable result with --json', async () => {
    writeRun('success');
    const result = await run(['wait', 'ci', SHA, '--repo', 'o/r', '--settle', '1s', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { result: string; runs: { name: string }[] };
    expect(parsed.result).toBe('passed');
    expect(parsed.runs[0]?.name).toBe('CI / Publish');
  });

  it('ignores a run of another repository', async () => {
    writeRun('success');
    const result = await run(['wait', 'ci', SHA, '--repo', 'other/repo', '--settle', '1s']);
    // Nothing matches and no relay runs in the throwaway config dir: fails fast, with the fix
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('queue relay start');
  });

  it('exits 3 at once with the fix when nothing was recorded and the relay is not running', async () => {
    const result = await run(['wait', 'ci', SHA, '--repo', 'o/r']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('relay client is not running');
    expect(result.stderr).toContain('queue relay start');
  });

  it('exits 4 with an actionable message for something that is not a SHA', async () => {
    const result = await run(['wait', 'ci', 'main']);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('is not a commit SHA');
  });

  it('exits 4 for an unknown wait target and for a bad duration', async () => {
    const unknown = await run(['wait', 'pizza']);
    expect(unknown.exitCode).toBe(4);
    expect(unknown.stderr).toContain('Unknown wait target');

    const badDuration = await run(['wait', 'ci', SHA, '--timeout', 'soon']);
    expect(badDuration.exitCode).toBe(4);
    expect(badDuration.stderr).toContain('durations look like');
  });
});
