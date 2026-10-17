import { describe, it, expect } from 'vitest';
import type { HistoryEntry } from '@wadeck-app/queue-core';
import { collectRuns, evaluateRuns, shaMatches, WORKFLOW_RUN_EVENT, type CiWaitOptions } from './ciWait.js';

const SHA = '9d9c4f7a36576a2c268e42d0c7b372e64b30ea19';

function entry(ts: string, run: Record<string, unknown>, repo = 'wadeck-app/queue', event = WORKFLOW_RUN_EVENT): HistoryEntry {
  return {
    ts,
    eventId: `${ts}-${String(run.id)}-${String(run.status)}`,
    event,
    subscribers: [],
    orphan: false,
    payload: { action: run.status, workflow_run: { head_sha: SHA, run_attempt: 1, ...run }, repository: { full_name: repo } },
  };
}

const options: CiWaitOptions = { sha: SHA.slice(0, 7), workflows: [], settleMs: 20_000 };
const at = (iso: string) => Date.parse(iso);

describe('shaMatches', () => {
  it('accepts a prefix, case-insensitively', () => {
    expect(shaMatches('9D9C4F7', SHA)).toBe(true);
    expect(shaMatches('abc1234', SHA)).toBe(false);
  });
});

describe('collectRuns', () => {
  it('keeps the latest state per run id', () => {
    const runs = collectRuns([
      entry('2026-10-17T10:00:00Z', { id: 1, name: 'CI', status: 'in_progress' }),
      entry('2026-10-17T10:01:00Z', { id: 1, name: 'CI', status: 'completed', conclusion: 'success' }),
    ], options);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('ignores other commits, other events and other repositories', () => {
    const runs = collectRuns([
      entry('2026-10-17T10:00:00Z', { id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: 'f'.repeat(40) }),
      entry('2026-10-17T10:00:00Z', { id: 2, name: 'CI', status: 'completed', conclusion: 'success' }, 'wadeck-app/queue', 'on.github.check_run'),
      entry('2026-10-17T10:00:00Z', { id: 3, name: 'CI', status: 'completed', conclusion: 'success' }, 'someone/else'),
    ], { ...options, repo: 'wadeck-app/queue' });
    expect(runs).toEqual([]);
  });

  it('a re-run (higher attempt) replaces the completed first attempt, and a late attempt-1 event does not win back', () => {
    const runs = collectRuns([
      entry('2026-10-17T10:00:00Z', { id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }),
      entry('2026-10-17T10:05:00Z', { id: 1, name: 'CI', status: 'in_progress', run_attempt: 2 }),
      entry('2026-10-17T10:06:00Z', { id: 1, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1 }),
    ], options);
    expect(runs[0]).toMatchObject({ attempt: 2, status: 'in_progress' });
  });
});

describe('evaluateRuns', () => {
  const done = (id: number, name: string, conclusion: string, ts = '2026-10-17T10:00:00Z') =>
    collectRuns([entry(ts, { id, name, status: 'completed', conclusion })], options)[0]!;

  it('is pending with an explicit reason when no run was seen', () => {
    const verdict = evaluateRuns([], options, at('2026-10-17T10:10:00Z'));
    expect(verdict).toMatchObject({ state: 'pending' });
    expect((verdict as { reason: string }).reason).toContain('no workflow run seen');
  });

  it('is pending while a run is in progress', () => {
    const running = collectRuns([entry('2026-10-17T10:00:00Z', { id: 1, name: 'CI', status: 'in_progress' })], options);
    const verdict = evaluateRuns(running, options, at('2026-10-17T10:10:00Z'));
    expect(verdict.state).toBe('pending');
  });

  it('waits for the settle window after the last completion, then passes', () => {
    const runs = [done(1, 'CI', 'success')];
    expect(evaluateRuns(runs, options, at('2026-10-17T10:00:05Z')).state).toBe('pending');
    expect(evaluateRuns(runs, options, at('2026-10-17T10:00:21Z')).state).toBe('passed');
  });

  it('answers at once when the CI finished long before the command started (no race)', () => {
    expect(evaluateRuns([done(1, 'CI', 'success', '2026-10-17T09:00:00Z')], options, at('2026-10-17T10:00:00Z')).state).toBe('passed');
  });

  it('fails when any run is not success/skipped/neutral and lists it', () => {
    const verdict = evaluateRuns([done(1, 'CI', 'success'), done(2, 'Lint', 'failure'), done(3, 'Docs', 'skipped')], options, at('2026-10-17T11:00:00Z'));
    expect(verdict.state).toBe('failed');
    expect((verdict as { failed: { name: string }[] }).failed.map((r) => r.name)).toEqual(['Lint']);
  });

  it('cancelled and timed_out count as failures', () => {
    expect(evaluateRuns([done(1, 'CI', 'cancelled')], options, at('2026-10-17T11:00:00Z')).state).toBe('failed');
    expect(evaluateRuns([done(1, 'CI', 'timed_out')], options, at('2026-10-17T11:00:00Z')).state).toBe('failed');
  });

  describe('with --workflow', () => {
    const named: CiWaitOptions = { ...options, workflows: ['CI'] };

    it('is pending until the named workflow has a run, whatever else completed', () => {
      const verdict = evaluateRuns([done(2, 'Docs', 'success')], named, at('2026-10-17T11:00:00Z'));
      expect(verdict.state).toBe('pending');
      expect((verdict as { reason: string }).reason).toContain('"CI"');
    });

    it('needs no settle window and ignores the unrelated failing workflow', () => {
      const runs = [done(1, 'CI', 'success', '2026-10-17T10:00:00Z'), done(2, 'Docs', 'failure', '2026-10-17T10:00:00Z')];
      expect(evaluateRuns(runs, named, at('2026-10-17T10:00:01Z')).state).toBe('passed');
    });
  });
});
