import { describe, it, expect } from 'vitest';
import { summarizeGithubPayload } from './summarize.js';

describe('summarizeGithubPayload', () => {
  it('extracts repository.full_name from GitHub push payload', () => {
    const payload = {
      repository: { full_name: 'org/repo' },
      ref: 'refs/heads/main',
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('org/repo');
  });

  it('extracts sender.login from GitHub payload', () => {
    const payload = {
      sender: { login: 'alice' },
      action: 'opened',
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('alice');
  });

  it('removes refs/heads/ prefix from ref', () => {
    const payload = {
      ref: 'refs/heads/feature/my-feature',
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('feature/my-feature');
    expect(summary).not.toContain('refs/heads/');
  });

  it('includes head_commit.message first line', () => {
    const payload = {
      head_commit: {
        message: 'Fix bug in parser\n\nThis is a longer description',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('Fix bug in parser');
    expect(summary).not.toContain('This is a longer description');
  });

  it('includes commits count', () => {
    const payload = {
      commits: [{ id: '1' }, { id: '2' }, { id: '3' }],
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('3');
  });

  it('includes pull_request number and title', () => {
    const payload = {
      pull_request: {
        number: 42,
        title: 'Add new feature',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('#42');
    expect(summary).toContain('Add new feature');
  });

  it('includes issue number and title', () => {
    const payload = {
      issue: {
        number: 99,
        title: 'Bug report',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('#99');
    expect(summary).toContain('Bug report');
  });

  it('includes workflow_run name and conclusion', () => {
    const payload = {
      workflow_run: {
        name: 'Tests',
        conclusion: 'success',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('Tests');
    expect(summary).toContain('success');
  });

  it('includes check_run name and conclusion', () => {
    const payload = {
      check_run: {
        name: 'Linter',
        conclusion: 'failure',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toContain('Linter');
    expect(summary).toContain('failure');
  });

  it('truncates comment.body to first 40 chars', () => {
    const payload = {
      comment: {
        body: 'This is a very long comment that goes on and on and on',
      },
    };
    const summary = summarizeGithubPayload(payload);
    expect(summary?.length).toBeLessThanOrEqual(110);
    expect(summary).toContain('This is a very long comment that goes o');
  });

  it('returns null for unknown payload shape', () => {
    const payload = { foo: 'bar' };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toBeNull();
  });
});
