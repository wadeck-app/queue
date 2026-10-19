/**
 * Infers, from the workflow files committed in the repository, which GitHub workflows a push of a commit
 * is expected to start. Pure logic: the caller reads git and passes the facts in.
 *
 * Only what can be decided with certainty becomes "expected". Anything GitHub would decide differently
 * from what a static read can tell (path filters on a multi-commit push, PR-only workflows) is reported as
 * "possible" and never waited for, so the inference can make the wait more precise but never wrong-blocking.
 */

import { load as yamlLoad } from 'js-yaml';
import { getErrorMessage } from '@wadeck-app/queue-core';

export interface PushFilters {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

export interface WorkflowDef {
  /** The `name:` key (what GitHub reports as workflow_run.name), or the file path when absent. */
  name: string;
  file: string;
  push: PushFilters | null;
  pullRequest: boolean;
  /** Triggers that cannot be decided from the commit (workflow_run, workflow_dispatch, schedule, ...) are ignored; this flags a file we could not read. */
  unreadable?: string;
}

export interface InferenceFacts {
  workflows: WorkflowDef[];
  /** Branch the commit was pushed to; null when unknown (detached HEAD, explicit SHA). */
  branch: string | null;
  /** Files touched by the tip commit; null when unknown. */
  changedFiles: string[] | null;
}

export type Inference =
  | { kind: 'expected'; workflows: string[]; possible: string[]; notes: string[] }
  | { kind: 'none'; reasons: string[] }
  | { kind: 'unknown'; notes: string[] };

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

export function parseWorkflowFile(file: string, content: string): WorkflowDef {
  let doc: unknown;
  try {
    doc = yamlLoad(content);
  } catch (err) {
    return { name: file, file, push: null, pullRequest: false, unreadable: getErrorMessage(err) };
  }
  if (!doc || typeof doc !== 'object') return { name: file, file, push: null, pullRequest: false, unreadable: 'not a YAML mapping' };

  const record = doc as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : file;
  // YAML 1.1 parsers may turn the bare key `on` into `true`; js-yaml keeps it a string, but stay tolerant
  const on = record.on ?? record['true'];

  let push: PushFilters | null = null;
  let pullRequest = false;
  const readPush = (cfg: unknown): PushFilters => {
    const c = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>;
    return {
      branches: asStringList(c.branches),
      branchesIgnore: asStringList(c['branches-ignore']),
      tags: asStringList(c.tags),
      paths: asStringList(c.paths),
      pathsIgnore: asStringList(c['paths-ignore']),
    };
  };

  if (typeof on === 'string') {
    if (on === 'push') push = {};
    if (on === 'pull_request') pullRequest = true;
  } else if (Array.isArray(on)) {
    if (on.includes('push')) push = {};
    if (on.includes('pull_request')) pullRequest = true;
  } else if (on && typeof on === 'object') {
    const triggers = on as Record<string, unknown>;
    if ('push' in triggers) push = readPush(triggers.push);
    if ('pull_request' in triggers) pullRequest = true;
  }

  return { name, file, push, pullRequest };
}

/** GitHub filter globs: `*` stops at `/`, `**` crosses it, `?` is one non-slash character. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(value));
}

/** A leading `!` negates inside include lists: the semantics depend on ordering, which we do not model. */
function hasNegation(patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((p) => p.startsWith('!'));
}

export function inferExpectedWorkflows(facts: InferenceFacts): Inference {
  const notes: string[] = [];
  const expected: string[] = [];
  const possible: string[] = [];
  const reasons: string[] = [];

  for (const wf of facts.workflows) {
    if (wf.unreadable) {
      notes.push(`${wf.file} could not be parsed (${wf.unreadable}); it is not taken into account`);
      return { kind: 'unknown', notes };
    }
    if (!wf.push) {
      reasons.push(wf.pullRequest
        ? `"${wf.name}" only runs on pull requests (possible if a PR exists for this commit)`
        : `"${wf.name}" has no push trigger (manual or scheduled)`);
      if (wf.pullRequest) possible.push(wf.name);
      continue;
    }

    const f = wf.push;
    if (hasNegation(f.branches) || hasNegation(f.paths)) {
      notes.push(`"${wf.name}" uses negated filter patterns, which are not evaluated`);
      return { kind: 'unknown', notes };
    }

    // A push trigger with only a tag filter never starts on a branch push
    if (f.tags && !f.branches && !f.branchesIgnore) {
      reasons.push(`"${wf.name}" runs on tag pushes only`);
      continue;
    }

    if (f.branches || f.branchesIgnore) {
      if (facts.branch === null) {
        notes.push(`branch unknown (detached HEAD or explicit SHA): "${wf.name}" has a branch filter, so the expectation is not computed`);
        return { kind: 'unknown', notes };
      }
      if (f.branches && !matchesAny(f.branches, facts.branch)) {
        reasons.push(`"${wf.name}" runs on branches [${f.branches.join(', ')}], not "${facts.branch}"`);
        continue;
      }
      if (f.branchesIgnore && matchesAny(f.branchesIgnore, facts.branch)) {
        reasons.push(`"${wf.name}" ignores branch "${facts.branch}"`);
        continue;
      }
    }

    if (f.paths || f.pathsIgnore) {
      if (facts.changedFiles === null) {
        notes.push(`changed files unknown: "${wf.name}" has a path filter, so the expectation is not computed`);
        return { kind: 'unknown', notes };
      }
      const touched = facts.changedFiles;
      const included = f.paths ? touched.some((file) => matchesAny(f.paths!, file)) : true;
      const notIgnored = f.pathsIgnore ? touched.some((file) => !matchesAny(f.pathsIgnore!, file)) : true;
      if (!included || !notIgnored) {
        // The push may carry earlier commits that touch these paths: only the tip commit is known
        possible.push(wf.name);
        reasons.push(`"${wf.name}" has a path filter that the tip commit does not match (it still starts if an earlier commit of the same push does)`);
        continue;
      }
    }

    expected.push(wf.name);
  }

  if (expected.length > 0) return { kind: 'expected', workflows: expected, possible, notes };
  if (possible.length > 0) {
    notes.push(...reasons);
    return { kind: 'unknown', notes };
  }
  return { kind: 'none', reasons };
}
