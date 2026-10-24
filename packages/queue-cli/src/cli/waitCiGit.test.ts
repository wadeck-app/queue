import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueWaitCommand } from './waitCli.js';
import type { GitPort } from './ciGit.js';

// `queue wait ci` end to end inside this process: the real command, the real history reader, a fake git, a fake relay start.
// No git repository, no child process: the result does not depend on how fast the machine is. What git decides in each
// situation is covered in ciGit.test.ts; here the decisions are wired to the history and to the exit codes.

const HEAD = 'a'.repeat(40);
const WORKFLOW = 'name: My CI\non:\n  push:\n    branches: [main]\n';

function fakeGit(options: { pushed?: boolean; branch?: string } = {}): GitPort {
  const answer = (args: string[]): string | null => {
    const key = args.join(' ');
    if (key === 'rev-parse HEAD' || key.startsWith('rev-parse --verify')) {
      return HEAD;
    }
    if (key === 'rev-parse --abbrev-ref HEAD') {
      return options.branch ?? 'main';
    }
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
      return `origin/${options.branch ?? 'main'}`;
    }
    if (key === 'remote get-url origin') {
      return 'git@github.com:o/r.git';
    }
    if (key.startsWith('ls-tree')) {
      return '.github/workflows/ci.yml';
    }
    if (key.startsWith('show')) {
      return WORKFLOW;
    }
    if (key.startsWith('diff-tree')) {
      return 'src/a.ts';
    }
    throw new Error(`unexpected git call: git ${key}`);
  };
  return {
    read: answer,
    succeeds: (args) => {
      if (args[0] === 'merge-base') {
        return options.pushed !== false;
      }
      throw new Error(`unexpected git call: git ${args.join(' ')}`);
    },
  };
}

let configDir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-wait-ci-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function recordRun(name: string, conclusion = 'success'): void {
  const historyDir = join(configDir, 'history');
  mkdirSync(historyDir, { recursive: true });
  const ts = new Date(Date.now() - 120_000).toISOString();
  const record = {
    ts, type: 'trigger', eventId: `evt-${name}`, event: 'on.github.workflow_run', matchedCount: 0, totalCount: 0,
    payload: {
      action: 'completed',
      workflow_run: { id: name.length, name, head_sha: HEAD, run_attempt: 1, status: 'completed', conclusion, html_url: 'https://github.com/o/r/actions/runs/1' },
      repository: { full_name: 'o/r' },
    },
  };
  writeFileSync(join(historyDir, `${ts.slice(0, 10)}.ndjson`), JSON.stringify(record) + '\n', { flag: 'a' });
}

// The relay cannot start in the throwaway config dir: the wait must stop at once instead of waiting for it
const relayCannotStart = async (): Promise<number> => 1;

const run = (args: string[], git: GitPort): Promise<number> => queueWaitCommand(configDir, ['ci', ...args], relayCannotStart, { git });

describe('queue wait ci with git', () => {
  it('defaults to HEAD, infers the workflow from .github/workflows and passes', async () => {
    recordRun('My CI');
    const exitCode = await run(['--repo', 'o/r'], fakeGit());
    expect(exitCode).toBe(0);
    expect(stderr).toContain('expecting "My CI"');
    expect(stdout).toContain('My CI');
  });

  it('does not conclude on an unrelated workflow while the inferred one has not run', async () => {
    recordRun('Some Other App');
    const exitCode = await run(['--repo', 'o/r'], fakeGit());
    // No relay in the throwaway config dir: it stops at once instead of passing on the wrong workflow
    expect(exitCode).toBe(3);
    expect(stdout).not.toContain('CI passed');
    expect(stderr).toContain('"My CI"');
  });

  it('refuses a commit that was never pushed, with the fix', async () => {
    recordRun('My CI');
    const exitCode = await run(['--repo', 'o/r'], fakeGit({ pushed: false }));
    expect(exitCode).toBe(3);
    expect(stderr).toContain('was not pushed');
    expect(stderr).toContain('git push');
  });

  it('says nothing will run when the branch is not covered by any workflow', async () => {
    const exitCode = await run(['--repo', 'o/r'], fakeGit({ branch: 'feature/x' }));
    expect(exitCode).toBe(3);
    expect(stderr).toContain('No workflow is configured to run on a push');
    expect(stderr).toContain('not "feature/x"');
  });

  it('an explicit --workflow wins over the inference, even on an uncovered branch', async () => {
    recordRun('External CI');
    const exitCode = await run(['--repo', 'o/r', '--workflow', 'External CI'], fakeGit({ branch: 'feature/x' }));
    expect(exitCode).toBe(0);
  });

  it('--no-infer skips the workflow files: git is only asked for the commit and the remote', async () => {
    recordRun('Whatever');
    const read = vi.fn(fakeGit().read);
    const git: GitPort = { read, succeeds: () => true };
    const exitCode = await run(['--repo', 'o/r', '--no-infer', '--workflow', 'Whatever'], git);
    expect(exitCode).toBe(0);
    const calls = read.mock.calls.map(([args]) => args.join(' '));
    expect(calls.some((call) => call.startsWith('ls-tree') || call.startsWith('show'))).toBe(false);
  });

  it('asks for the SHA when the current directory is not a git repository', async () => {
    const noRepository: GitPort = { read: () => null, succeeds: () => false };
    const exitCode = await run([], noRepository);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('not a git repository');
  });
});
