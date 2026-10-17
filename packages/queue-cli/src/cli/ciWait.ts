/**
 * `queue wait ci`: decides, from the `on.github.workflow_run` entries of the history, whether the CI of a commit is done.
 * Pure logic only (no I/O, no clock): the caller feeds the entries and the current time.
 *
 * GitHub exposes no "whole commit" status, so "done" is defined here:
 *  - with --workflow names: exactly those workflows have a completed run for the SHA;
 *  - otherwise: every run seen for the SHA is completed, and nothing new happened for `settleMs`
 *    (a workflow that has not emitted `requested` yet must not make us fire too early).
 */

import type { HistoryEntry } from '@wadeck-app/queue-core';

export const WORKFLOW_RUN_EVENT = 'on.github.workflow_run';

/** Conclusions that count as a green CI. */
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export const CI_EXIT = {
  PASSED: 0,
  FAILED: 1,
  TIMEOUT: 2,
  NO_RUN: 3,
  USAGE: 4,
} as const;

export interface CiRun {
  id: number;
  name: string;
  attempt: number;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  /** Timestamp of the history entry that carried this state (not the GitHub one). */
  seenAt: string;
}

export interface CiWaitOptions {
  /** Full or abbreviated (>= 7 chars) commit SHA. */
  sha: string;
  /** `owner/name`; when absent, any repository matches. */
  repo?: string;
  /** Exact workflow names that must have completed; when empty, every run seen for the SHA counts. */
  workflows: string[];
  settleMs: number;
}

export type CiVerdict =
  | { state: 'pending'; runs: CiRun[]; reason: string }
  | { state: 'passed' | 'failed'; runs: CiRun[]; failed: CiRun[] };

interface WorkflowRunPayload {
  action?: string;
  workflow_run?: {
    id?: number;
    name?: string;
    head_sha?: string;
    run_attempt?: number;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    run_started_at?: string;
  };
  repository?: { full_name?: string };
}

export function shaMatches(wanted: string, actual: string): boolean {
  return actual.toLowerCase().startsWith(wanted.toLowerCase());
}

/**
 * Collapses the history entries of a commit into the latest known state per workflow run.
 * A re-run keeps the same run id with a higher attempt, which replaces the previous attempt.
 */
export function collectRuns(entries: HistoryEntry[], options: Pick<CiWaitOptions, 'sha' | 'repo'>): CiRun[] {
  const byId = new Map<number, CiRun>();
  const chronological = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));

  for (const entry of chronological) {
    if (entry.event !== WORKFLOW_RUN_EVENT || entry.orphan) continue;
    const payload = entry.payload as WorkflowRunPayload | undefined;
    const run = payload?.workflow_run;
    if (!run || typeof run.id !== 'number' || typeof run.head_sha !== 'string') continue;
    if (!shaMatches(options.sha, run.head_sha)) continue;
    if (options.repo && payload?.repository?.full_name?.toLowerCase() !== options.repo.toLowerCase()) continue;

    const attempt = run.run_attempt ?? 1;
    const known = byId.get(run.id);
    if (known && known.attempt > attempt) continue;

    byId.set(run.id, {
      id: run.id,
      name: run.name ?? `run ${run.id}`,
      attempt,
      status: run.status ?? 'unknown',
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? '',
      startedAt: run.run_started_at ?? null,
      seenAt: entry.ts,
    });
  }

  return [...byId.values()];
}

export function evaluateRuns(runs: CiRun[], options: CiWaitOptions, nowMs: number): CiVerdict {
  const required = options.workflows;
  const relevant = required.length > 0 ? runs.filter((r) => required.includes(r.name)) : runs;

  if (required.length > 0) {
    const missing = required.filter((name) => !relevant.some((r) => r.name === name));
    if (missing.length > 0) {
      return { state: 'pending', runs: relevant, reason: `no run seen yet for workflow(s): ${missing.map((m) => `"${m}"`).join(', ')}` };
    }
  } else if (relevant.length === 0) {
    return { state: 'pending', runs: relevant, reason: 'no workflow run seen yet for this commit' };
  }

  const running = relevant.filter((r) => r.status !== 'completed');
  if (running.length > 0) {
    return { state: 'pending', runs: relevant, reason: `still running: ${running.map((r) => `"${r.name}" (${r.status})`).join(', ')}` };
  }

  // Explicit workflows are a complete list; otherwise wait for the quiet window so a late-starting workflow is not missed
  if (required.length === 0) {
    const lastActivityMs = Math.max(...relevant.map((r) => Date.parse(r.seenAt)));
    const quietMs = nowMs - lastActivityMs;
    if (quietMs < options.settleMs) {
      return {
        state: 'pending',
        runs: relevant,
        reason: `all seen runs completed, waiting ${Math.ceil((options.settleMs - quietMs) / 1000)}s for late workflows (--settle)`,
      };
    }
  }

  const failed = relevant.filter((r) => !PASSING_CONCLUSIONS.has(r.conclusion ?? ''));
  return { state: failed.length === 0 ? 'passed' : 'failed', runs: relevant, failed };
}

export function formatDuration(run: CiRun): string {
  if (!run.startedAt) return '';
  const ms = Date.parse(run.seenAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function formatRunLine(run: CiRun): string {
  const outcome = run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status;
  const duration = formatDuration(run);
  return `  ${outcome.padEnd(10)} ${run.name}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}${duration ? `  ${duration}` : ''}${run.url ? `  ${run.url}` : ''}`;
}
