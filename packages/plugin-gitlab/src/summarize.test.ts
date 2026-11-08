import { describe, it, expect } from 'vitest';
import { summarizeGitlabPayload } from './summarize.js';

/*
 * Fixtures follow GitLab's documented webhook payload shapes (docs.gitlab.com, "Webhook events"), cut down to the fields
 * the summary reads. Only the `issue` event was seen on a real delivery; merge_request, pipeline, push, job (build),
 * release, deployment, wiki_page, feature_flag, member and note shapes come from the documentation, not from a delivery.
 */
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
      object_kind: 'merge_request',
      event_type: 'merge_request',
      user: { id: 1, name: 'Administrator', username: 'root' },
      project: { id: 1, name: 'Gitlab Test', path_with_namespace: 'gitlab-org/gitlab-test' },
      object_attributes: { id: 99, iid: 1, target_branch: 'master', source_branch: 'ms-viewport', title: 'MS-Viewport', state: 'opened', action: 'open' },
      repository: { name: 'Gitlab Test' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('gitlab-org/gitlab-test | by root | action=open | #1 MS-Viewport | ms-viewport -> master');
  });

  it('describes a push: user_username, branch without refs/heads/, commit count', () => {
    const payload = {
      object_kind: 'push',
      event_name: 'push',
      before: '95790bf891e76fee5e1747ab589903a6a1f80f22',
      after: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      ref: 'refs/heads/feature/y',
      user_id: 4,
      user_name: 'John Smith',
      user_username: 'jsmith',
      project: { path_with_namespace: 'mike/diaspora' },
      commits: [{ id: 'b6568db' }, { id: 'da15608' }],
      total_commits_count: 4,
    };
    expect(summarizeGitlabPayload(payload)).toBe('mike/diaspora | by jsmith | feature/y | 4 commits');
  });

  it('falls back to the length of commits when total_commits_count is absent', () => {
    expect(summarizeGitlabPayload({ ref: 'refs/heads/main', commits: [{}, {}] })).toBe('main | 2 commits');
  });

  it('says deleted, not 0 commits, for a push that deletes a branch (after is all zeros)', () => {
    const payload = {
      object_kind: 'push',
      before: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      after: '0'.repeat(40),
      ref: 'refs/heads/old',
      checkout_sha: null,
      user_username: 'jsmith',
      project: { path_with_namespace: 'mike/diaspora' },
      commits: [],
      total_commits_count: 0,
    };
    expect(summarizeGitlabPayload(payload)).toBe('mike/diaspora | by jsmith | old | deleted');
  });

  it('keeps 0 commits for a new branch without commits (before is all zeros, after is not)', () => {
    const payload = {
      before: '0'.repeat(40),
      after: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      ref: 'refs/heads/new',
      commits: [],
      total_commits_count: 0,
    };
    expect(summarizeGitlabPayload(payload)).toBe('new | 0 commits');
  });

  it('keeps a tag ref as is, minus refs/tags/', () => {
    expect(summarizeGitlabPayload({ ref: 'refs/tags/v1.2.0' })).toBe('v1.2.0');
  });

  it('describes a pipeline: ref and status', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 31, iid: 3, ref: 'master', tag: false, sha: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2', status: 'success', source: 'push' },
      user: { id: 1, name: 'Administrator', username: 'root' },
      project: { path_with_namespace: 'gitlab-org/gitlab-test' },
      builds: [{ id: 380, stage: 'deploy', name: 'production', status: 'skipped' }],
    };
    expect(summarizeGitlabPayload(payload)).toBe('gitlab-org/gitlab-test | by root | master | pipeline success');
  });

  it('shows merge request !iid for a merge request pipeline instead of the raw refs/merge-requests/ ref', () => {
    const payload = {
      object_kind: 'pipeline',
      object_attributes: { id: 32, ref: 'refs/merge-requests/5/head', status: 'running', source: 'merge_request_event' },
      user: { username: 'root' },
      project: { path_with_namespace: 'g/p' },
      merge_request: { id: 1, iid: 5, title: 'T', source_branch: 'feature', target_branch: 'main' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by root | merge request !5 | pipeline running');
  });

  it('describes a job (build) from its real shape: project_name, user.name (no username), top-level ref', () => {
    const payload = {
      object_kind: 'build',
      ref: 'main',
      tag: false,
      build_id: 1977,
      build_name: 'test',
      build_stage: 'test',
      build_status: 'success',
      project_id: 380,
      project_name: 'gitlab-org/gitlab-test',
      user: { id: 3, name: 'Carol Doe', email: 'carol@example.com' },
      repository: { name: 'gitlab_test', homepage: 'http://gitlab.example.com/gitlab-org/gitlab-test' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('gitlab-org/gitlab-test | by Carol Doe | main | job test success');
  });

  it('falls back to repository.name when a job carries no project_name', () => {
    const payload = { object_kind: 'build', ref: 'main', build_name: 'test', build_status: 'failed', repository: { name: 'gitlab_test' } };
    expect(summarizeGitlabPayload(payload)).toBe('gitlab_test | main | job test failed');
  });

  it('describes a release: action, tag and a name that differs from the tag', () => {
    const payload = {
      object_kind: 'release',
      action: 'create',
      tag: 'v1.1',
      name: 'Big release',
      description: 'v1.1 has been released',
      project: { path_with_namespace: 'g/p' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | action=create | release v1.1 "Big release"');
    expect(summarizeGitlabPayload({ ...payload, name: 'v1.1' })).toBe('g/p | action=create | release v1.1');
  });

  it('describes a deployment: environment, status and short sha', () => {
    const payload = {
      object_kind: 'deployment',
      status: 'success',
      deployment_id: 15,
      deployable_url: 'http://gitlab.example.com/gitlab-org/gitlab-test/-/jobs/796',
      environment: 'staging',
      project: { path_with_namespace: 'g/p' },
      short_sha: '279484c0',
      user: { id: 1, name: 'Administrator', username: 'root' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by root | deployment staging success | 279484c0');
  });

  it('describes a wiki page: action and title', () => {
    const payload = {
      object_kind: 'wiki_page',
      user: { username: 'root' },
      project: { path_with_namespace: 'g/p' },
      object_attributes: { title: 'Awesome', slug: 'awesome', format: 'markdown', action: 'create' },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by root | action=create | wiki page "Awesome"');
  });

  it('describes a feature flag: name and state', () => {
    const payload = {
      object_kind: 'feature_flag',
      project: { path_with_namespace: 'g/p' },
      user: { username: 'root' },
      object_attributes: { id: 6, name: 'test-feature-flag', description: 'd', active: true },
    };
    expect(summarizeGitlabPayload(payload)).toBe('g/p | by root | feature flag test-feature-flag enabled');
    expect(summarizeGitlabPayload({ ...payload, object_attributes: { id: 6, name: 'test-feature-flag', active: false } })).toBe(
      'g/p | by root | feature flag test-feature-flag disabled',
    );
  });

  it('describes a project member event: the member is not the actor, no "by"', () => {
    const payload = {
      project_name: 'StoreCloud',
      project_path: 'storecloud',
      project_path_with_namespace: 'jsmith/storecloud',
      project_id: 74,
      user_username: 'johnsmith',
      user_name: 'John Smith',
      user_id: 41,
      access_level: 'Developer',
      event_name: 'user_add_to_team',
    };
    expect(summarizeGitlabPayload(payload)).toBe('jsmith/storecloud | member johnsmith added (Developer)');
  });

  it('describes a group member event', () => {
    const payload = {
      group_name: 'Group1',
      group_path: 'group1',
      group_id: 1,
      user_username: 'johnsmith',
      group_access: 'Guest',
      event_name: 'user_remove_from_group',
    };
    expect(summarizeGitlabPayload(payload)).toBe('group1 | member johnsmith removed (Guest)');
  });

  it('describes a note: first 40 characters of the comment', () => {
    const long = 'x'.repeat(60);
    const summary = summarizeGitlabPayload({ object_attributes: { note: long } });
    expect(summary).toBe(`comment: "${'x'.repeat(40)}..."`);
  });

  it('cuts a note after 40 characters, not 39 and not 41', () => {
    expect(summarizeGitlabPayload({ object_attributes: { note: 'y'.repeat(40) } })).toBe(`comment: "${'y'.repeat(40)}"`);
    expect(summarizeGitlabPayload({ object_attributes: { note: 'y'.repeat(41) } })).toBe(`comment: "${'y'.repeat(40)}..."`);
  });

  it('keeps a short note whole', () => {
    expect(summarizeGitlabPayload({ object_attributes: { note: 'LGTM' } })).toBe('comment: "LGTM"');
  });

  it('says on which merge request, issue, commit or snippet a note was left', () => {
    const base = { object_kind: 'note', user: { username: 'root' }, project: { path_with_namespace: 'g/p' } };
    expect(
      summarizeGitlabPayload({ ...base, object_attributes: { note: 'LGTM', noteable_type: 'MergeRequest' }, merge_request: { iid: 5, title: 'T' } }),
    ).toBe('g/p | by root | comment on merge request !5: "LGTM"');
    expect(summarizeGitlabPayload({ ...base, object_attributes: { note: 'hm', noteable_type: 'Issue' }, issue: { iid: 3, title: 'T' } })).toBe(
      'g/p | by root | comment on issue #3: "hm"',
    );
    expect(
      summarizeGitlabPayload({ ...base, object_attributes: { note: 'hm', noteable_type: 'Commit' }, commit: { id: 'cfe32603c0d7592c5d6e5d2bd4a3bb1c4f4b4a8d' } }),
    ).toBe('g/p | by root | comment on commit cfe32603: "hm"');
    expect(summarizeGitlabPayload({ ...base, object_attributes: { note: 'hm', noteable_type: 'Snippet' }, snippet: { id: 7, title: 'T' } })).toBe(
      'g/p | by root | comment on snippet $7: "hm"',
    );
  });

  it('collapses a multi-line note to a single line before cutting it', () => {
    expect(summarizeGitlabPayload({ object_attributes: { note: 'line one\n\n  line\r\n\ttwo' } })).toBe('comment: "line one line two"');
  });

  it('collapses a multi-line title to a single line', () => {
    expect(summarizeGitlabPayload({ object_attributes: { iid: 1, title: 'one\ntwo' } })).toBe('#1 one two');
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

  it('keeps unknown shapes null, also when object_kind names a known event without its fields', () => {
    expect(summarizeGitlabPayload({ object_kind: 'wiki_page' })).toBeNull();
    expect(summarizeGitlabPayload({ object_kind: 'deployment', environment: 1, status: 2 })).toBeNull();
    expect(summarizeGitlabPayload({ object_kind: 'feature_flag', object_attributes: {} })).toBeNull();
    expect(summarizeGitlabPayload({ object_kind: 'release' })).toBeNull();
    expect(summarizeGitlabPayload({ event_name: 'user_create', name: 'x', username: 'y', email: 'z' })).toBeNull();
  });
});
