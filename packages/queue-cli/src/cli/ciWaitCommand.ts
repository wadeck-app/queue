/**
 * `queue wait ci [sha]`: blocks until the CI of a commit is done, so an agent that just pushed can stop polling.
 * It reads the history (where the relayed `on.github.workflow_run` events land, even when nobody subscribed),
 * which also covers a CI that finished before this command started: no subscribe-before-push race.
 */

import type { HistoryEntry } from '@wadeck-app/queue-core';
import { CI_EXIT, collectRuns, evaluateRuns, formatRunLine, type CiRun, type CiWaitOptions } from './ciWait.js';

export interface WaitIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export interface RelayLiveness {
  running: boolean;
  connected: boolean;
}

export interface CiWaitDeps {
  readEntries: (sinceMs: number) => HistoryEntry[];
  relayStatus: () => Promise<RelayLiveness>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  io: WaitIO;
}

export interface CiWaitCommandOptions extends CiWaitOptions {
  timeoutMs: number;
  /** How long to tolerate "no run seen" before declaring that nothing is going to come. */
  startGraceMs: number;
  pollMs: number;
  /** How far back the history is scanned for runs of this SHA. */
  lookbackMs: number;
  json: boolean;
}

const RELAY_HINT = 'Start it with "queue relay start" (check "queue relay status" and "queue relay webhook history").';

export async function ciWaitCommand(options: CiWaitCommandOptions, deps: CiWaitDeps): Promise<number> {
  const { io } = deps;
  const startMs = deps.now();
  let lastProgress = '';
  let relayChecked = false;

  for (;;) {
    const nowMs = deps.now();
    const runs = collectRuns(deps.readEntries(nowMs - options.lookbackMs), options);
    const verdict = evaluateRuns(runs, options, nowMs);

    if (verdict.state !== 'pending') {
      return report(verdict.state, verdict.runs, verdict.state === 'failed' ? verdict.failed : [], options, io);
    }

    // Nothing can arrive if the relay is down: say it right away instead of waiting for the timeout
    if (!relayChecked) {
      relayChecked = true;
      const relay = await deps.relayStatus();
      if (!relay.running) {
        io.stderr.write(`[fail] The relay client is not running, so no GitHub event can reach the queue. ${RELAY_HINT}\n`);
        return CI_EXIT.NO_RUN;
      }
      if (!relay.connected) {
        io.stderr.write('[warn] The relay client is running but not connected to the relay right now; waiting for it to reconnect.\n');
      }
    }

    const elapsedMs = nowMs - startMs;
    if (verdict.runs.length === 0 || options.workflows.length > 0) {
      const nothingSeen = options.workflows.length > 0
        ? options.workflows.some((w) => !verdict.runs.some((r) => r.name === w))
        : verdict.runs.length === 0;
      if (nothingSeen && elapsedMs >= options.startGraceMs) {
        io.stderr.write(
          `[fail] ${verdict.reason} after ${Math.round(elapsedMs / 1000)}s. Likely causes: the workflow has a path/branch filter that skips this commit, ` +
          `GitHub did not deliver the webhook (see "queue relay webhook history"), or the relay does not forward workflow_run events. ` +
          `Cross-check with "gh run list --commit ${options.sha}".\n`,
        );
        return CI_EXIT.NO_RUN;
      }
    }

    if (elapsedMs >= options.timeoutMs) {
      io.stderr.write(
        `[fail] Timed out after ${Math.round(options.timeoutMs / 1000)}s: ${verdict.reason}. ` +
        `Cross-check with "gh run list --commit ${options.sha}"; re-run "queue wait ci" to keep waiting.\n`,
      );
      if (options.json) io.stdout.write(JSON.stringify({ sha: options.sha, result: 'timeout', reason: verdict.reason, runs: verdict.runs }, null, 2) + '\n');
      return CI_EXIT.TIMEOUT;
    }

    if (verdict.reason !== lastProgress) {
      lastProgress = verdict.reason;
      io.stderr.write(`[queue] ${verdict.reason}\n`);
    }
    await deps.sleep(options.pollMs);
  }
}

function report(
  state: 'passed' | 'failed',
  runs: CiRun[],
  failed: CiRun[],
  options: CiWaitCommandOptions,
  io: WaitIO,
): number {
  if (options.json) {
    io.stdout.write(JSON.stringify({ sha: options.sha, result: state, runs, failed }, null, 2) + '\n');
  } else {
    io.stdout.write(`CI ${state === 'passed' ? 'passed' : 'FAILED'} for ${options.sha.slice(0, 12)}:\n`);
    for (const run of runs) io.stdout.write(formatRunLine(run) + '\n');
  }
  return state === 'passed' ? CI_EXIT.PASSED : CI_EXIT.FAILED;
}

/** `https://github.com/o/r.git`, `git@github.com:o/r.git` and `ssh://git@github.com/o/r` all give `o/r`. */
export function parseGithubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
