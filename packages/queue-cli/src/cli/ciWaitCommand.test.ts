import { describe, it, expect } from 'vitest';
import type { HistoryEntry } from '@wadeck-app/queue-core';
import { ciWaitCommand, parseGithubRepo, type CiWaitCommandOptions, type CiWaitDeps, type RelayLiveness } from './ciWaitCommand.js';
import { CI_EXIT, WORKFLOW_RUN_EVENT } from './ciWait.js';

const SHA = '9d9c4f7a36576a2c268e42d0c7b372e64b30ea19';
const T0 = Date.parse('2026-10-17T10:00:00Z');

function runEntry(ts: number, status: string, conclusion: string | null = null, name = 'CI'): HistoryEntry {
  const iso = new Date(ts).toISOString();
  return {
    ts: iso,
    eventId: `${iso}-${status}-${name}`,
    event: WORKFLOW_RUN_EVENT,
    subscribers: [],
    orphan: false,
    payload: { workflow_run: { id: 1, name, head_sha: SHA, run_attempt: 1, status, conclusion, html_url: 'https://github.com/o/r/actions/runs/1' }, repository: { full_name: 'o/r' } },
  };
}

interface Harness {
  deps: CiWaitDeps;
  out: string[];
  err: string[];
  clock: { now: number };
  relayCalls: number;
}

/** A virtual clock: sleeping advances time, and `script(now)` returns what the history holds at that moment. */
function harness(script: (now: number) => HistoryEntry[], relay: RelayLiveness = { running: true, connected: true }): Harness {
  const h = { out: [] as string[], err: [] as string[], clock: { now: T0 }, relayCalls: 0 } as Harness;
  h.deps = {
    readEntries: () => script(h.clock.now),
    relayStatus: async () => { h.relayCalls++; return relay; },
    now: () => h.clock.now,
    sleep: async (ms) => { h.clock.now += ms; },
    io: { stdout: { write: (s) => { h.out.push(s); } }, stderr: { write: (s) => { h.err.push(s); } } },
  };
  return h;
}

const base: CiWaitCommandOptions = {
  sha: SHA,
  workflows: [],
  settleMs: 20_000,
  timeoutMs: 15 * 60_000,
  startGraceMs: 90_000,
  pollMs: 1000,
  lookbackMs: 24 * 3600_000,
  json: false,
};

describe('ciWaitCommand', () => {
  it('returns 0 immediately when the CI already finished before the command started', async () => {
    const h = harness(() => [runEntry(T0 - 3600_000, 'completed', 'success')]);
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.PASSED);
    expect(h.relayCalls).toBe(0);
    expect(h.out.join('')).toContain('CI passed');
  });

  it('waits for a run that starts and completes later, then passes after the settle window', async () => {
    const h = harness((now) => {
      const entries: HistoryEntry[] = [];
      if (now >= T0 + 5_000) {
        entries.push(runEntry(T0 + 5_000, 'in_progress'));
      }
      if (now >= T0 + 60_000) {
        entries.push(runEntry(T0 + 60_000, 'completed', 'success'));
      }
      return entries;
    });
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.PASSED);
    expect(h.clock.now).toBeGreaterThanOrEqual(T0 + 80_000);
  });

  it('returns 1 and names the failing run', async () => {
    const h = harness(() => [runEntry(T0 - 60_000, 'completed', 'failure', 'Lint')]);
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.FAILED);
    expect(h.out.join('')).toContain('FAILED');
    expect(h.out.join('')).toContain('Lint');
  });

  it('prints parseable JSON with --json', async () => {
    const h = harness(() => [runEntry(T0 - 60_000, 'completed', 'success')]);
    await ciWaitCommand({ ...base, json: true }, h.deps);
    const parsed = JSON.parse(h.out.join('')) as { result: string; runs: unknown[] };
    expect(parsed.result).toBe('passed');
    expect(parsed.runs).toHaveLength(1);
  });

  it('returns 3 at once, with the fix, when nothing was seen and the relay is not running', async () => {
    const h = harness(() => [], { running: false, connected: false });
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.NO_RUN);
    expect(h.err.join('')).toContain('queue relay start');
    expect(h.clock.now).toBe(T0);
  });

  it('returns 3 with the likely causes when no run shows up within the start grace', async () => {
    const h = harness(() => []);
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.NO_RUN);
    expect(h.clock.now - T0).toBeGreaterThanOrEqual(90_000);
    expect(h.clock.now - T0).toBeLessThan(95_000);
    expect(h.err.join('')).toContain('path/branch filter');
    expect(h.err.join('')).toContain('gh run list --commit');
  });

  it('warns but keeps waiting when the relay runs without being connected', async () => {
    const h = harness((now) => (now >= T0 + 10_000 ? [runEntry(T0 - 100_000, 'completed', 'success')] : []), { running: true, connected: false });
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.PASSED);
    expect(h.err.join('')).toContain('not connected');
  });

  it('returns 2 (distinct from a failure) when a run never completes', async () => {
    const h = harness(() => [runEntry(T0, 'in_progress')]);
    expect(await ciWaitCommand({ ...base, timeoutMs: 30_000 }, h.deps)).toBe(CI_EXIT.TIMEOUT);
    expect(h.err.join('')).toContain('Timed out');
    expect(h.err.join('')).toContain('still running');
  });

  it('with --workflow, reports no-run for a workflow that never appears even if others completed', async () => {
    const h = harness(() => [runEntry(T0 - 60_000, 'completed', 'success', 'Docs')]);
    expect(await ciWaitCommand({ ...base, workflows: ['CI'] }, h.deps)).toBe(CI_EXIT.NO_RUN);
    expect(h.err.join('')).toContain('"CI"');
  });

  it('prints one progress line for the whole settle window, not one per second', async () => {
    const h = harness((now) => (now >= T0 ? [runEntry(T0, 'completed', 'success')] : []));
    expect(await ciWaitCommand(base, h.deps)).toBe(CI_EXIT.PASSED);
    expect(h.err.filter((l) => l.startsWith('[queue]'))).toHaveLength(1);
  });

  it('only logs a progress line when the situation changes', async () => {
    const h = harness(() => [runEntry(T0, 'in_progress')]);
    await ciWaitCommand({ ...base, timeoutMs: 20_000 }, h.deps);
    expect(h.err.filter((l) => l.startsWith('[queue]'))).toHaveLength(1);
  });
});

describe('parseGithubRepo', () => {
  it.each([
    ['https://github.com/wadeck-app/queue.git', 'wadeck-app/queue'],
    ['git@github.com:wadeck-app/queue.git', 'wadeck-app/queue'],
    ['ssh://git@github.com/wadeck-app/queue', 'wadeck-app/queue'],
    ['https://github.com/wadeck-app/queue/', 'wadeck-app/queue'],
  ])('%s', (url, expected) => {
    expect(parseGithubRepo(url)).toBe(expected);
  });

  it('returns null for a non-GitHub remote', () => {
    expect(parseGithubRepo('https://gitlab.com/a/b.git')).toBeNull();
  });
});

describe('ciWaitCommand: no run seen, was anything delivered for this repository?', () => {
  const elsewhere = (): HistoryEntry => ({ ...runEntry(T0 - 3_600_000, 'completed', 'success'), eventId: 'other', payload: { workflow_run: { id: 7, name: 'CI', head_sha: 'f'.repeat(40), run_attempt: 1, status: 'completed', conclusion: 'success' }, repository: { full_name: 'wadeck-app/scrapers' } } });

  it('says no delivery from this repository reached the relay, lists the ones that did, and explains that a webhook only covers the repositories of its owner', async () => {
    const h = harness(() => [elsewhere()]);
    expect(await ciWaitCommand({ ...base, repo: 'Wadeck/poc-node-infomaniak' }, h.deps)).toBe(CI_EXIT.NO_RUN);
    const text = h.err.join('');
    expect(text).toContain('No workflow_run delivery from Wadeck/poc-node-infomaniak reached the relay in the last 24 h');
    expect(text).toContain('wadeck-app/scrapers');
    expect(text).toContain('only covers the repositories of its owner');
    expect(text).toContain('queue relay webhook list');
  });

  it('says the relay delivered nothing at all when the history holds no workflow_run in the last 24 h', async () => {
    const h = harness(() => []);
    await ciWaitCommand({ ...base, repo: 'o/r' }, h.deps);
    expect(h.err.join('')).toContain('delivered no workflow_run event at all in the last 24 h');
  });

  it('does not blame the webhook when the repository did deliver (another commit): the cause is elsewhere (path filter, branch)', async () => {
    const sameRepoOtherCommit: HistoryEntry = { ...elsewhere(), payload: { workflow_run: { id: 8, name: 'CI', head_sha: 'e'.repeat(40), run_attempt: 1, status: 'completed', conclusion: 'success' }, repository: { full_name: 'o/r' } } };
    const h = harness(() => [sameRepoOtherCommit]);
    await ciWaitCommand({ ...base, repo: 'o/r' }, h.deps);
    const text = h.err.join('');
    expect(text).toContain('path/branch filter');
    expect(text).not.toContain('reached the relay in the last 24 h');
  });
});
