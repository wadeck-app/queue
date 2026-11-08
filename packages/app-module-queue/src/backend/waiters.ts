import { WAITER_HEARTBEAT_MS, WaiterRegistry, getErrorMessage, listLiveWaiters, waitersDir, type LiveWaiter, type WaiterRegistryDeps } from '@wadeck-app/queue-core';

/** A heartbeat later than this (two periods) is shown as stale: the wait may be stalled; it is dropped from the list after the TTL (60 s). Same limit as `queue waiters`. */
export const STALE_AFTER_MS = 2 * WAITER_HEARTBEAT_MS;

/** A wait started without `--name` is called `anon.<pid>` (queue-cli `ANONYMOUS_PREFIX`; this module does not depend on queue-cli). */
const ANONYMOUS_PREFIX = 'anon.';

export interface WaitersDeps {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  fs?: WaiterRegistryDeps['fs'];
}

// Names, filters, labels and paths come from files another process wrote: no control character may reach the page (or a terminal that copies from it)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function printable(text: string): string {
  return text.replace(CONTROL, '');
}

/** `5s`, `2m 3s`, `1h 4m` (never negative). Same wording as `queue waiters`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function isAnonymous(name: string): boolean {
  return name.startsWith(ANONYMOUS_PREFIX);
}

/** What the page prints for the filters of a wait: all of them must hold. */
export function whensText(whens: readonly string[]): string {
  return whens.join(' and ');
}

export interface WaiterRow {
  name: string;
  anonymous: boolean;
  /** `anonymous` or empty: the text of the badge (a table column cannot badge a boolean). */
  anonymousText: string;
  events: string[];
  /** The events as one text, for the table. */
  eventsText: string;
  /** The `--when` filters as written. */
  whens: string[];
  whensText: string;
  label: string;
  contact: 'none' | 'pipe';
  contactText: string;
  pid: number;
  cwd: string;
  /** ISO: when the wait registered. */
  since: string;
  /** ISO: the last heartbeat. */
  lastSeen: string;
  stale: boolean;
  /** `stale` or empty: the text of the badge. */
  staleText: string;
}

export interface WaitersAnswer {
  waiters: WaiterRow[];
  /** Live waits (the figure next to the menu entry). */
  count: number;
  staleCount: number;
  anonymousCount: number;
  /** Waits found over and recorded as lost by this request: which ones. Absent when none. */
  sweptText?: string;
  /** Files that cannot be used and bounds that were hit, one text. Absent when none. */
  warningText?: string;
}

function pathOf(problem: string): string {
  const end = problem.indexOf('.json');
  return end === -1 ? problem : problem.slice(0, end + 5);
}

export interface Swept {
  /** Names of the waits recorded as lost. */
  removed: string[];
  sweptText?: string;
  /** Problems of files the sweep left alone. */
  problems: string[];
}

/**
 * The waits that are over (process gone or no heartbeat for the TTL) leave a file: each is removed and recorded once as `lost`, like `queue waiters` does before it lists,
 * so the page and the CLI agree. A live wait is never touched. A folder that cannot be read or written throws an Error that names it and what to do.
 */
export function sweepWaiters(configDir: string, deps: WaitersDeps = {}): Swept {
  const diagnostics: string[] = [];
  let report: { removed: string[]; problems: string[] };
  try {
    report = new WaiterRegistry(configDir, {
      ...(deps.now !== undefined && { now: deps.now }),
      ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }),
      ...(deps.fs !== undefined && { fs: deps.fs }),
      onDiagnostic: (message) => { diagnostics.push(message); },
      onRetention: (lines) => { diagnostics.push(...lines.map((line) => line.message)); },
    }).sweepStale();
  } catch (error) {
    const message = getErrorMessage(error);
    throw new Error(message.includes('Fix:') ? message : `Cannot read the waits of ${waitersDir(configDir)}: ${message}. Fix: check that the folder is readable and writable by the user the dashboard runs as.`, { cause: error });
  }
  const count = report.removed.length;
  return {
    removed: report.removed,
    ...(count > 0 && { sweptText: `${count} wait${count === 1 ? '' : 's'} that ended without a trace ${count === 1 ? 'was' : 'were'} recorded as lost: ${report.removed.map(printable).join(', ')}.` }),
    problems: [...report.problems, ...diagnostics],
  };
}

function row(waiter: LiveWaiter, nowMs: number): WaiterRow {
  const anonymous = isAnonymous(waiter.name);
  const stale = nowMs - waiter.lastSeenMs > STALE_AFTER_MS;
  const events = waiter.events.map(printable);
  const whens = waiter.whens.map(printable);
  return {
    name: printable(waiter.name),
    anonymous,
    anonymousText: anonymous ? 'anonymous' : '',
    events,
    eventsText: events.join(', '),
    whens,
    whensText: whensText(whens),
    label: printable(waiter.label),
    contact: waiter.contact.kind,
    contactText: waiter.contact.kind === 'none' ? 'polling only' : waiter.contact.kind,
    pid: waiter.pid,
    cwd: printable(waiter.cwd),
    since: waiter.startedAt,
    lastSeen: new Date(waiter.lastSeenMs).toISOString(),
    stale,
    staleText: stale ? 'stale' : '',
  };
}

/** The problems to show once each: a file the sweep already complained about is not repeated by the scan. */
export function warningsOf(swept: readonly string[], others: readonly string[]): string | undefined {
  const said = new Set(swept.map(pathOf));
  const texts = [...swept, ...others.filter((problem) => !said.has(pathOf(problem)))].map(printable);
  return texts.length === 0 ? undefined : texts.join(' ');
}

/**
 * The `queue wait` processes that are waiting right now, read from `waiters/waiter-<name>.json` (no daemon needed, nothing started). The id of a registration is not
 * returned. Files that cannot be used are named in `warningText`; a folder that cannot be read throws (see {@link sweepWaiters}).
 */
export function getWaiters(configDir: string, deps: WaitersDeps = {}): WaitersAnswer {
  const now = deps.now ?? Date.now;
  const swept = sweepWaiters(configDir, deps);
  const scanned = listLiveWaiters(configDir, { now, ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }), ...(deps.fs !== undefined && { fs: deps.fs }) });
  const waiters = scanned.waiters.map((waiter) => row(waiter, now()));
  const warningText = warningsOf(swept.problems, scanned.problems);
  return {
    waiters,
    count: waiters.length,
    staleCount: waiters.filter((waiter) => waiter.stale).length,
    anonymousCount: waiters.filter((waiter) => waiter.anonymous).length,
    ...(swept.sweptText !== undefined && { sweptText: swept.sweptText }),
    ...(warningText !== undefined && { warningText }),
  };
}
