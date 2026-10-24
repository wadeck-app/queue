import { describe, it, expect } from 'vitest';
import { inspectRepository, type GitPort } from './ciGit.js';
import { CI_EXIT } from './ciWait.js';

// `inspectRepository` decides from what git says. It is tested against a FAKE git that answers exactly the commands the code
// issues and fails on any other: no repository is created, no process is started, so nothing here depends on the speed of the
// machine. The real git adapter (createGitPort) is a dozen lines that run `git <args>`.

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

interface Scenario {
  /** What `rev-parse --verify <sha>^{commit}` gives per input; absent = the commit does not exist here. */
  resolves?: Record<string, string>;
  head?: string;
  branch?: string;
  /** Upstream branch of HEAD; null = none. */
  upstream?: string | null;
  /** Commits that are ancestors of the upstream (were pushed). */
  pushed?: string[];
  /** Whether the repository has any remote-tracking branch. */
  hasOriginRefs?: boolean;
  /** Commits contained in a remote-tracking branch of origin. */
  onOrigin?: string[];
  /** Workflow files of the commit: path -> content. */
  workflows?: Record<string, string>;
  changed?: string[];
}

function fakeGit(scenario: Scenario): GitPort & { calls: string[] } {
  const calls: string[] = [];
  const answer = (args: string[]): string | null => {
    const [a, b, c, d, e] = args;
    if (a === 'rev-parse' && b === '--verify') {
      return scenario.resolves?.[String(c).replace('^{commit}', '')] ?? null;
    }
    if (a === 'rev-parse' && b === 'HEAD') {
      return scenario.head ?? HEAD;
    }
    if (a === 'rev-parse' && b === '--abbrev-ref' && c === 'HEAD') {
      return scenario.branch ?? 'main';
    }
    if (a === 'rev-parse' && b === '--abbrev-ref' && c === '--symbolic-full-name' && d === '@{u}') {
      return scenario.upstream === undefined ? 'origin/main' : scenario.upstream;
    }
    if (a === 'for-each-ref' && b === '--count=1' && c === 'refs/remotes/origin') {
      return scenario.hasOriginRefs === false ? null : 'refs/remotes/origin/main';
    }
    if (a === 'for-each-ref' && b === '--count=1' && c === '--contains') {
      return (scenario.onOrigin ?? []).includes(String(d)) ? 'refs/remotes/origin/main' : null;
    }
    if (a === 'ls-tree' && b === '-r') {
      return Object.keys(scenario.workflows ?? {}).join('\n');
    }
    if (a === 'show') {
      const file = String(b).split(':')[1] ?? '';
      return scenario.workflows?.[file] ?? null;
    }
    if (a === 'diff-tree') {
      return (scenario.changed ?? []).join('\n');
    }
    throw new Error(`unexpected git call: git ${args.join(' ')}`);
  };
  return {
    calls,
    read(args) {
      calls.push(args.join(' '));
      return answer(args);
    },
    succeeds(args) {
      calls.push(args.join(' '));
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return (scenario.pushed ?? []).includes(String(args[2]));
      }
      throw new Error(`unexpected git call: git ${args.join(' ')}`);
    },
  };
}

const WORKFLOW = 'name: My CI\non:\n  push:\n    branches: [main]\n';

function run(scenario: Scenario, options: { sha?: string; repo?: string; remoteRepo?: string | null; infer?: boolean } = {}) {
  const git = fakeGit({ resolves: { [HEAD]: HEAD, [OTHER]: OTHER }, pushed: [HEAD], workflows: { '.github/workflows/ci.yml': WORKFLOW }, changed: ['src/a.ts'], ...scenario });
  const stderr: string[] = [];
  const step = inspectRepository(git, { sha: options.sha ?? HEAD, repo: options.repo, remoteRepo: options.remoteRepo ?? null, infer: options.infer ?? true }, (line) => stderr.push(line));
  return { step, stderr: stderr.join(''), git };
}

describe('inspectRepository: the push check', () => {
  it('lets a pushed HEAD through, and infers the workflow that a push to its branch starts', () => {
    const { step } = run({});
    expect(step).toMatchObject({ proceed: true, workflows: ['My CI'] });
  });

  it('refuses a HEAD that is not on its upstream, saying nothing will ever run and how to fix it', () => {
    const { step, stderr } = run({ pushed: [] });
    expect(step).toEqual({ proceed: false, exitCode: CI_EXIT.NO_RUN });
    expect(stderr).toContain('was not pushed');
    expect(stderr).toContain('git push');
  });

  it('notes, without refusing, that a branch with no upstream cannot be checked', () => {
    const { step } = run({ upstream: null });
    expect(step).toMatchObject({ proceed: true });
    expect((step as { notes: string[] }).notes.join(' ')).toContain('has no upstream');
  });

  it('refuses an explicit SHA that is not HEAD and is on no origin branch, with the fix', () => {
    const { step, stderr } = run({ onOrigin: [] }, { sha: OTHER });
    expect(step).toEqual({ proceed: false, exitCode: CI_EXIT.NO_RUN });
    expect(stderr).toContain('not on any origin branch');
    expect(stderr).toContain('git push');
    expect(stderr).toContain('git fetch');
  });

  it('waits normally for an explicit SHA that is not HEAD but is on an origin branch', () => {
    const { step } = run({ onOrigin: [OTHER] }, { sha: OTHER });
    expect(step).toMatchObject({ proceed: true });
  });

  it('does not refuse an explicit SHA when the repository has no remote-tracking branch to compare with', () => {
    const { step } = run({ hasOriginRefs: false }, { sha: OTHER });
    expect(step).toMatchObject({ proceed: true });
  });

  it('skips the git checks, with a note, when the commit is not in this repository', () => {
    const { step } = run({ resolves: {} });
    expect(step).toMatchObject({ proceed: true, workflows: [] });
    expect((step as { notes: string[] }).notes.join(' ')).toContain('commit not found');
  });

  it('skips the checks, with a note, when --repo is not the repository of the origin remote', () => {
    const { step } = run({}, { repo: 'o/other', remoteRepo: 'o/r' });
    expect(step).toMatchObject({ proceed: true, workflows: [] });
    expect((step as { notes: string[] }).notes.join(' ')).toContain('differs from the "origin" remote');
  });
});

describe('inspectRepository: the workflow inference', () => {
  it('without inference only checks the push: it never reads the workflow files', () => {
    const { step, git } = run({}, { infer: false });
    expect(step).toEqual({ proceed: true, workflows: [], notes: [] });
    expect(git.calls.some((call) => call.startsWith('ls-tree') || call.startsWith('show'))).toBe(false);
  });

  it('says nothing will run when no workflow is configured for a push to this branch, and names the branch', () => {
    const { step, stderr } = run({ branch: 'feature/x', upstream: 'origin/feature/x', pushed: [HEAD] });
    expect(step).toEqual({ proceed: false, exitCode: CI_EXIT.NO_RUN });
    expect(stderr).toContain('No workflow is configured to run on a push');
    expect(stderr).toContain('not "feature/x"');
    expect(stderr).toContain('--workflow');
  });

  it('notes that there is no workflow file at all and falls back to every run seen for the commit', () => {
    const { step } = run({ workflows: {} });
    expect(step).toMatchObject({ proceed: true, workflows: [] });
    expect((step as { notes: string[] }).notes.join(' ')).toContain('no .github/workflows');
  });

  it('keeps the workflows it cannot decide out of the wait, as "may also run"', () => {
    const { step } = run({
      workflows: { '.github/workflows/ci.yml': WORKFLOW, '.github/workflows/pr.yml': 'name: PR only\non:\n  pull_request: {}\n' },
    });
    expect(step).toMatchObject({ proceed: true, workflows: ['My CI'] });
  });
});
