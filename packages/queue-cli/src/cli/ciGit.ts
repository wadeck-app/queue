/**
 * The git-aware part of `queue wait ci`: refuse to wait for a commit that was never pushed, and work out which workflows a push is
 * expected to start. The decisions take a {@link GitPort}, so they are tested against a fake git; createGitPort is the only code
 * that starts a git process.
 */

import { execFileSync } from 'node:child_process';
import { CI_EXIT } from './ciWait.js';
import { inferExpectedWorkflows, parseWorkflowFile } from './ciInfer.js';

/** What the inspection needs from git. */
export interface GitPort {
  /** Output of `git <args>` (trimmed), or null when git fails. */
  read(args: string[]): string | null;
  /** Whether `git <args>` exits 0. */
  succeeds(args: string[]): boolean;
}

export function createGitPort(): GitPort {
  return {
    read(args) {
      try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
      } catch {
        return null;
      }
    },
    succeeds(args) {
      try {
        execFileSync('git', args, { stdio: 'ignore', windowsHide: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type GitStep = { proceed: true; workflows: string[]; notes: string[] } | { proceed: false; exitCode: number };

export interface RepositoryFacts {
  sha: string;
  /** Repository named with --repo, if any. */
  repo: string | undefined;
  /** Repository of the "origin" remote, if it is a GitHub one. */
  remoteRepo: string | null;
  /** Whether to infer the expected workflows (false when the user named them or passed --no-infer). */
  infer: boolean;
}

/**
 * Looks at the local git repository to (1) refuse to wait for a commit that was never pushed and
 * (2) work out which workflows the push is expected to start. Never guesses: whatever cannot be decided
 * becomes a note and the default behaviour (every run seen for the commit) applies. `write` receives what is printed on stderr.
 */
export function inspectRepository(git: GitPort, facts: RepositoryFacts, write: (text: string) => void): GitStep {
  const { sha, repo, remoteRepo, infer } = facts;
  const notes: string[] = [];
  const resolved = git.read(['rev-parse', '--verify', `${sha}^{commit}`]);
  if (!resolved) {
    return { proceed: true, workflows: [], notes: ['commit not found in the current git repository: push check and workflow inference skipped'] };
  }
  if (repo && remoteRepo && repo.toLowerCase() !== remoteRepo.toLowerCase()) {
    return { proceed: true, workflows: [], notes: [`--repo ${repo} differs from the "origin" remote (${remoteRepo}): push check and workflow inference skipped`] };
  }

  const isHead = resolved === git.read(['rev-parse', 'HEAD']);
  const branch = isHead ? git.read(['rev-parse', '--abbrev-ref', 'HEAD']) : null;

  if (isHead) {
    const upstream = git.read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) {
      notes.push(`branch "${branch ?? 'HEAD'}" has no upstream: cannot verify that this commit was pushed`);
    } else if (!git.succeeds(['merge-base', '--is-ancestor', resolved, upstream])) {
      write(`[fail] Commit ${resolved.slice(0, 12)} is not on ${upstream}: it was not pushed, so no CI will ever run for it. Run "git push", then "queue wait ci" again.\n`);
      return { proceed: false, exitCode: CI_EXIT.NO_RUN };
    }
  } else if (git.read(['for-each-ref', '--count=1', 'refs/remotes/origin']) &&
    !git.read(['for-each-ref', '--count=1', '--contains', resolved, 'refs/remotes/origin'])) {
    // An explicit SHA that is not HEAD has no upstream to compare with: it must be on at least one remote branch
    write(`[fail] Commit ${resolved.slice(0, 12)} is not on any origin branch: it was not pushed, so no CI will ever run for it. Run "git push", then "queue wait ci" again (if it was pushed from elsewhere, run "git fetch" first).\n`);
    return { proceed: false, exitCode: CI_EXIT.NO_RUN };
  }

  if (!infer) {
    return { proceed: true, workflows: [], notes };
  }

  const listing = git.read(['ls-tree', '-r', '--name-only', resolved, '--', '.github/workflows']);
  const files = (listing ?? '').split('\n').filter((f) => /\.ya?ml$/i.test(f));
  if (files.length === 0) {
    notes.push('no .github/workflows/*.yml in this commit: workflow inference skipped');
    return { proceed: true, workflows: [], notes };
  }

  const workflows = files.map((file) => parseWorkflowFile(file, git.read(['show', `${resolved}:${file}`]) ?? ''));
  const changed = git.read(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', resolved]);
  const changedFiles = changed ? changed.split('\n').filter(Boolean) : null;
  const inference = inferExpectedWorkflows({ workflows, branch: branch && branch !== 'HEAD' ? branch : null, changedFiles });

  if (inference.kind === 'expected') {
    if (inference.possible.length > 0) {
      notes.push(`not waited for, but may also run: ${inference.possible.map((p) => `"${p}"`).join(', ')}`);
    }
    notes.push(...inference.notes);
    return { proceed: true, workflows: inference.workflows, notes };
  }
  if (inference.kind === 'none') {
    write(
      `[fail] No workflow is configured to run on a push of this commit, so there is nothing to wait for:\n` +
      inference.reasons.map((r) => `  - ${r}`).join('\n') + '\n' +
      'If a CI is expected anyway (workflow_run, external app), name it with --workflow or skip the inference with --no-infer.\n',
    );
    return { proceed: false, exitCode: CI_EXIT.NO_RUN };
  }
  notes.push(...inference.notes, 'falling back to "every run seen for the commit" (--settle)');
  return { proceed: true, workflows: [], notes };
}
