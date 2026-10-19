/**
 * Integration test for the git-aware part of `queue wait ci`: the push check and the workflow inference,
 * against a real throwaway git repository (with a bare "origin") and a hand-written history.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');

const WORKFLOW = `name: My CI
on:
  push:
    branches: [main]
`;

describe('queue wait ci with a git repository', () => {
  let bundlePath: string;
  let base: string;
  let configDir: string;
  let work: string;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true }).trim();

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
    base = mkdtempSync(join(tmpdir(), 'queue-wait-git-'));
    configDir = join(base, 'config');
    mkdirSync(configDir);
    const origin = join(base, 'origin.git');
    work = join(base, 'work');
    mkdirSync(origin);
    mkdirSync(work);
    git(origin, 'init', '--bare', '-b', 'main');
    git(work, 'init', '-b', 'main');
    git(work, 'remote', 'add', 'origin', origin);
    mkdirSync(join(work, '.github/workflows'), { recursive: true });
    writeFileSync(join(work, '.github/workflows/ci.yml'), WORKFLOW);
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'init');
    git(work, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function recordRun(sha: string, name: string, conclusion = 'success'): void {
    const historyDir = join(configDir, 'history');
    mkdirSync(historyDir, { recursive: true });
    const ts = new Date(Date.now() - 120_000).toISOString();
    const record = {
      ts, type: 'trigger', eventId: `evt-${name}`, event: 'on.github.workflow_run', matchedCount: 0, totalCount: 0,
      payload: {
        action: 'completed',
        workflow_run: { id: name.length, name, head_sha: sha, run_attempt: 1, status: 'completed', conclusion, html_url: 'https://github.com/o/r/actions/runs/1' },
        repository: { full_name: 'o/r' },
      },
    };
    writeFileSync(join(historyDir, `${ts.slice(0, 10)}.ndjson`), JSON.stringify(record) + '\n', { flag: 'a' });
  }

  function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env: NodeJS.ProcessEnv = { ...gitEnv, QUEUE_CONFIG_DIR: configDir };
    delete env['NODE_OPTIONS'];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundlePath, 'wait', 'ci', ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not finish within 30s\n${stderr}`)); }, 30_000);
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });
  }

  it('defaults to HEAD, infers the workflow from .github/workflows and passes', async () => {
    const head = git(work, 'rev-parse', 'HEAD');
    recordRun(head, 'My CI');
    const result = await run(['--repo', 'o/r']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('expecting "My CI"');
    expect(result.stdout).toContain('My CI');
  });

  it('does not conclude on an unrelated workflow while the inferred one has not run', async () => {
    const head = git(work, 'rev-parse', 'HEAD');
    recordRun(head, 'Some Other App');
    const result = await run(['--repo', 'o/r']);
    // No relay in the throwaway config dir: it stops at once instead of passing on the wrong workflow
    expect(result.exitCode).toBe(3);
    expect(result.stdout).not.toContain('CI passed');
    expect(result.stderr).toContain('"My CI"');
  });

  it('refuses a commit that was never pushed, with the fix', async () => {
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'local only');
    recordRun(git(work, 'rev-parse', 'HEAD'), 'My CI');
    const result = await run(['--repo', 'o/r']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('was not pushed');
    expect(result.stderr).toContain('git push');
  });

  it('refuses an explicit SHA that is not HEAD and was never pushed', async () => {
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'local only');
    const unpushed = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'b.txt'), 'y');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'another local commit');
    const result = await run([unpushed.slice(0, 8), '--repo', 'o/r']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('not on any origin branch');
    expect(result.stderr).toContain('git push');
  });

  it('waits normally for an explicit SHA that is not HEAD but was pushed', async () => {
    const pushed = git(work, 'rev-parse', 'HEAD');
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'local only');
    recordRun(pushed, 'My CI');
    const result = await run([pushed.slice(0, 8), '--repo', 'o/r', '--workflow', 'My CI']);
    expect(result.exitCode).toBe(0);
  });

  it('--no-infer skips the git checks', async () => {
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'local only');
    recordRun(git(work, 'rev-parse', 'HEAD'), 'Whatever');
    const result = await run(['--repo', 'o/r', '--no-infer', '--settle', '1s']);
    expect(result.exitCode).toBe(0);
  });

  it('says nothing will run when the branch is not covered by any workflow', async () => {
    git(work, 'checkout', '-b', 'feature/x');
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'on a feature branch');
    git(work, 'push', '-u', 'origin', 'feature/x');
    const result = await run(['--repo', 'o/r']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('No workflow is configured to run on a push');
    expect(result.stderr).toContain('not "feature/x"');
  });

  it('an explicit --workflow wins over the inference, even on an uncovered branch', async () => {
    git(work, 'checkout', '-b', 'feature/x');
    writeFileSync(join(work, 'a.txt'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'on a feature branch');
    git(work, 'push', '-u', 'origin', 'feature/x');
    recordRun(git(work, 'rev-parse', 'HEAD'), 'External CI');
    const result = await run(['--repo', 'o/r', '--workflow', 'External CI']);
    expect(result.exitCode).toBe(0);
  });
});
