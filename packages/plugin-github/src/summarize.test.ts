import { describe, it, expect } from 'vitest';
import { summarizeGithubPayload } from './summarize.js';

describe('summarizeGithubPayload', () => {
  it('extracts repository.full_name and the branch from a GitHub push payload', () => {
    const payload = {
      repository: { full_name: 'org/repo' },
      ref: 'refs/heads/main',
    };
    expect(summarizeGithubPayload(payload)).toBe('org/repo | main');
  });

  it('extracts sender.login and the action', () => {
    const payload = {
      sender: { login: 'alice' },
      action: 'opened',
    };
    expect(summarizeGithubPayload(payload)).toBe('by alice | action=opened');
  });

  it('removes exactly the refs/heads/ prefix from ref', () => {
    expect(summarizeGithubPayload({ ref: 'refs/heads/feature/my-feature' })).toBe('feature/my-feature');
    // The prefix is 11 characters: a branch whose name starts right after it keeps its first letter
    expect(summarizeGithubPayload({ ref: 'refs/heads/abc' })).toBe('abc');
  });

  it('keeps a tag ref whole', () => {
    expect(summarizeGithubPayload({ ref: 'refs/tags/v1.0.0' })).toBe('refs/tags/v1.0.0');
  });

  it('includes the first line of head_commit.message only', () => {
    const payload = {
      head_commit: {
        message: 'Fix bug in parser\n\nThis is a longer description',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('"Fix bug in parser"');
  });

  it('drops the carriage return of a CRLF commit message', () => {
    expect(summarizeGithubPayload({ head_commit: { message: 'Fix it\r\nmore' } })).toBe('"Fix it"');
  });

  it('includes commits count', () => {
    const payload = {
      commits: [{ id: '1' }, { id: '2' }, { id: '3' }],
    };
    expect(summarizeGithubPayload(payload)).toBe('3 commits');
  });

  it('says deleted, not 0 commits, for a push that deletes a branch', () => {
    const payload = {
      ref: 'refs/heads/old',
      after: '0'.repeat(40),
      deleted: true,
      commits: [],
    };
    expect(summarizeGithubPayload(payload)).toBe('old | deleted');
  });

  it('keeps 0 commits for a push that is not a deletion', () => {
    expect(summarizeGithubPayload({ ref: 'refs/heads/new', after: 'a'.repeat(40), commits: [] })).toBe('new | 0 commits');
  });

  it('includes pull_request number and title', () => {
    const payload = {
      pull_request: {
        number: 42,
        title: 'Add new feature',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('#42 Add new feature');
  });

  it('includes issue number and title', () => {
    const payload = {
      issue: {
        number: 99,
        title: 'Bug report',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('#99 Bug report');
  });

  it('includes workflow_run name and conclusion', () => {
    const payload = {
      workflow_run: {
        name: 'Tests',
        conclusion: 'success',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('Tests success');
  });

  it('includes check_run name and conclusion', () => {
    const payload = {
      check_run: {
        name: 'Linter',
        conclusion: 'failure',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('Linter failure');
  });

  it('truncates comment.body to first 40 chars', () => {
    const payload = {
      comment: {
        body: 'This is a very long comment that goes on and on and on',
      },
    };
    expect(summarizeGithubPayload(payload)).toBe('comment: "This is a very long comment that goes on..."');
  });

  it('cuts a comment after 40 characters, not 39 and not 41', () => {
    expect(summarizeGithubPayload({ comment: { body: 'y'.repeat(40) } })).toBe(`comment: "${'y'.repeat(40)}"`);
    expect(summarizeGithubPayload({ comment: { body: 'y'.repeat(41) } })).toBe(`comment: "${'y'.repeat(40)}..."`);
  });

  it('collapses a multi-line comment to a single line before cutting it', () => {
    expect(summarizeGithubPayload({ comment: { body: 'line one\n\n  line\r\n\ttwo' } })).toBe('comment: "line one line two"');
  });

  it('collapses whitespace in a pull request or issue title', () => {
    expect(summarizeGithubPayload({ pull_request: { number: 1, title: 'a\nb' } })).toBe('#1 a b');
    expect(summarizeGithubPayload({ issue: { number: 2, title: 'c\r\nd' } })).toBe('#2 c d');
  });

  it('joins every known part in a fixed order', () => {
    const payload = {
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
      action: 'closed',
      pull_request: { number: 5, title: 'T' },
    };
    expect(summarizeGithubPayload(payload)).toBe('org/repo | by alice | action=closed | #5 T');
  });

  it('returns null for unknown payload shape', () => {
    const payload = { foo: 'bar' };
    const summary = summarizeGithubPayload(payload);
    expect(summary).toBeNull();
  });
});
