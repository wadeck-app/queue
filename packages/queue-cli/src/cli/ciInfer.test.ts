import { describe, it, expect } from 'vitest';
import { globToRegExp, inferExpectedWorkflows, parseWorkflowFile, type InferenceFacts } from './ciInfer.js';

const ciYaml = `
name: CI / Publish
on:
    push:
        branches: [main]
    pull_request:
    workflow_dispatch:
`;

describe('parseWorkflowFile', () => {
  it('reads the name and the push/pull_request triggers of the real workflow shape', () => {
    const wf = parseWorkflowFile('.github/workflows/publish-queue-cli.yml', ciYaml);
    expect(wf.name).toBe('CI / Publish');
    expect(wf.push?.branches).toEqual(['main']);
    expect(wf.pullRequest).toBe(true);
  });

  it('falls back to the file path when there is no name', () => {
    expect(parseWorkflowFile('.github/workflows/x.yml', 'on: push\njobs: {}\n').name).toBe('.github/workflows/x.yml');
  });

  it('understands the string and list forms of `on`', () => {
    expect(parseWorkflowFile('a.yml', 'name: A\non: push\n').push).toEqual({});
    expect(parseWorkflowFile('a.yml', 'name: A\non: [push, pull_request]\n')).toMatchObject({ push: {}, pullRequest: true });
  });

  it('reports a file it cannot parse instead of ignoring it', () => {
    expect(parseWorkflowFile('bad.yml', 'name: [unclosed').unreadable).toBeTruthy();
  });
});

describe('globToRegExp', () => {
  it('* stops at a slash, ** crosses it', () => {
    expect(globToRegExp('release/*').test('release/1.0')).toBe(true);
    expect(globToRegExp('release/*').test('release/1.0/rc')).toBe(false);
    expect(globToRegExp('release/**').test('release/1.0/rc')).toBe(true);
    expect(globToRegExp('**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('docs/**').test('docs/a.md')).toBe(true);
    expect(globToRegExp('main').test('main2')).toBe(false);
  });

  it('escapes regex characters', () => {
    expect(globToRegExp('v1.0').test('v1x0')).toBe(false);
  });
});

describe('inferExpectedWorkflows', () => {
  const wf = (yaml: string, file = 'w.yml') => parseWorkflowFile(file, yaml);
  const facts = (workflows: ReturnType<typeof wf>[], branch: string | null = 'main', changedFiles: string[] | null = ['src/a.ts']): InferenceFacts => ({ workflows, branch, changedFiles });

  it('expects the push workflow of this very repository on main', () => {
    expect(inferExpectedWorkflows(facts([wf(ciYaml)]))).toMatchObject({ kind: 'expected', workflows: ['CI / Publish'] });
  });

  it('expects nothing, with the reason, on a branch the workflow does not cover', () => {
    const result = inferExpectedWorkflows(facts([wf(ciYaml)], 'feature/x'));
    expect(result.kind).toBe('none');
    expect((result as { reasons: string[] }).reasons.join('\n')).toContain('not "feature/x"');
  });

  it('a PR-only workflow is never required: alone it leaves the verdict unknown (a PR may exist), next to a push workflow it is only possible', () => {
    const pr = wf('name: PR\non: pull_request\n', 'pr.yml');
    expect(inferExpectedWorkflows(facts([pr])).kind).toBe('unknown');
    expect(inferExpectedWorkflows(facts([pr, wf(ciYaml)]))).toMatchObject({ kind: 'expected', workflows: ['CI / Publish'], possible: ['PR'] });
  });

  it('an unknown branch with a branch filter is not guessed', () => {
    expect(inferExpectedWorkflows(facts([wf(ciYaml)], null)).kind).toBe('unknown');
  });

  it('honours branches-ignore and tag-only triggers', () => {
    expect(inferExpectedWorkflows(facts([wf('name: A\non:\n  push:\n    branches-ignore: [main]\n')])).kind).toBe('none');
    expect(inferExpectedWorkflows(facts([wf('name: A\non:\n  push:\n    tags: ["v*"]\n')])).kind).toBe('none');
  });

  it('a path filter matching the tip commit is expected; a non-matching one is only possible', () => {
    const docs = wf('name: Docs\non:\n  push:\n    paths: ["docs/**"]\n', 'docs.yml');
    expect(inferExpectedWorkflows(facts([wf(ciYaml), docs], 'main', ['docs/a.md']))).toMatchObject({ kind: 'expected', workflows: ['CI / Publish', 'Docs'] });

    const result = inferExpectedWorkflows(facts([wf(ciYaml), docs], 'main', ['src/a.ts']));
    expect(result).toMatchObject({ kind: 'expected', workflows: ['CI / Publish'], possible: ['Docs'] });
  });

  it('a path filter alone that does not match leaves the verdict unknown, not "nothing will run"', () => {
    const docs = wf('name: Docs\non:\n  push:\n    paths: ["docs/**"]\n', 'docs.yml');
    expect(inferExpectedWorkflows(facts([docs], 'main', ['src/a.ts'])).kind).toBe('unknown');
  });

  it('paths-ignore: only ignored files means it is not expected', () => {
    const w = wf('name: W\non:\n  push:\n    paths-ignore: ["**.md"]\n');
    expect(inferExpectedWorkflows(facts([w], 'main', ['README.md'])).kind).toBe('unknown');
    expect(inferExpectedWorkflows(facts([w], 'main', ['README.md', 'a.ts']))).toMatchObject({ kind: 'expected' });
  });

  it('unknown changed files with a path filter is not guessed', () => {
    const w = wf('name: W\non:\n  push:\n    paths: ["src/**"]\n');
    expect(inferExpectedWorkflows(facts([w], 'main', null)).kind).toBe('unknown');
  });

  it('negated patterns are declared unsupported rather than mis-evaluated', () => {
    const w = wf('name: W\non:\n  push:\n    branches: ["**", "!dev"]\n');
    const result = inferExpectedWorkflows(facts([w]));
    expect(result.kind).toBe('unknown');
    expect((result as { notes: string[] }).notes.join('\n')).toContain('negated');
  });

  it('an unparsable workflow makes the whole inference unknown', () => {
    expect(inferExpectedWorkflows(facts([wf(ciYaml), wf('name: [x', 'bad.yml')])).kind).toBe('unknown');
  });
});
