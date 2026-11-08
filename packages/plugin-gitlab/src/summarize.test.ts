import { describe, it, expect } from 'vitest';
import { summarizeGitlabPayload } from './summarize.js';

describe('summarizeGitlabPayload', () => {
  it('returns null when the payload has none of the known fields', () => {
    expect(summarizeGitlabPayload({})).toBeNull();
    expect(summarizeGitlabPayload({ unrelated: 1 })).toBeNull();
  });

  it('describes an issue delivery: project, actor, action, #iid and title', () => {
    const payload = {
      object_kind: 'issue',
      user: { username: 'wadeck', name: 'Wadeck Follonier' },
      project: { path_with_namespace: 'wadeck-app/app-core' },
      object_attributes: { iid: 7, action: 'open', title: 'Fix the thing', state: 'opened' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('wadeck-app/app-core | by wadeck | action=open | #7 Fix the thing');
  });

  it('describes a merge request: iid, title and source -> target branches', () => {
    const payload = {
      project: { path_with_namespace: 'g/p' },
      user: { username: 'bob' },
      object_attributes: { iid: 12, action: 'merge', title: 'Add x', source_branch: 'feature/x', target_branch: 'main' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by bob | action=merge | #12 Add x | feature/x -> main');
  });

  it('describes a push: user_username, branch without refs/heads/, commit count', () => {
    const payload = {
      project: { path_with_namespace: 'g/p' },
      user_username: 'alice',
      ref: 'refs/heads/feature/y',
      total_commits_count: 3,
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by alice | feature/y | 3 commits');
  });

  it('falls back to the length of commits when total_commits_count is absent', () => {
    expect(summarizeGitlabPayload({ ref: 'refs/heads/main', commits: [{}, {}] })).toBe('main | 2 commits');
  });

  it('keeps a tag ref as is, minus refs/tags/', () => {
    expect(summarizeGitlabPayload({ ref: 'refs/tags/v1.2.0' })).toBe('v1.2.0');
  });

  it('describes a pipeline: ref and status', () => {
    const payload = {
      project: { path_with_namespace: 'g/p' },
      user: { username: 'carol' },
      object_attributes: { id: 99, ref: 'main', status: 'failed' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by carol | main | pipeline failed');
  });

  it('describes a job: build_name and build_status', () => {
    expect(summarizeGitlabPayload({ project: { path_with_namespace: 'g/p' }, build_name: 'test', build_status: 'success' })).toBe('g/p | job test success');
  });

  it('describes a note: first 40 characters of the comment', () => {
    const long = 'x'.repeat(60);
    const summary = summarizeGitlabPayload({ object_attributes: { note: long } });
    expect(summary).toBe(`comment: "${'x'.repeat(40)}..."`);
  });

  it('keeps a short note whole', () => {
    expect(summarizeGitlabPayload({ object_attributes: { note: 'LGTM' } })).toBe('comment: "LGTM"');
  });

  it('only keeps the first line of a title', () => {
    expect(summarizeGitlabPayload({ object_attributes: { iid: 1, title: 'one\ntwo' } })).toBe('#1 one');
  });

  it('ignores fields of the wrong type instead of throwing', () => {
    const payload = {
      project: 'nope',
      user: 5,
      object_attributes: 'nope',
      ref: 42,
      commits: 'many',
      total_commits_count: 'three',
      build_name: 1,
    };
    expect(summarizeGitlabPayload(payload)).toBeNull();
  });
});
