import { WAITER_STALE_AFTER_MS, isAnonymousWaiterName, listLiveWaiters, type LiveWaiter, type WaiterRegistryDeps } from '@wadeck-app/queue-core';

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
  return isAnonymousWaiterName(name);
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
  /** Files that cannot be used and bounds that were hit, one text. Absent when none. */
  warningText?: string;
}

function row(waiter: LiveWaiter, nowMs: number): WaiterRow {
  const anonymous = isAnonymous(waiter.name);
  const stale = nowMs - waiter.lastSeenMs > WAITER_STALE_AFTER_MS;
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

/** The problems to show once each, as one text. Absent when there are none. */
export function warningsOf(problems: readonly string[]): string | undefined {
  const texts = [...new Set(problems.map(printable))];
  return texts.length === 0 ? undefined : texts.join(' ');
}

/**
 * The `queue wait` processes that are waiting right now, read from `waiters/waiter-<name>.json` (no daemon needed, nothing started). READ ONLY: a wait that is over (process
 * gone, no heartbeat for the TTL) is simply not listed; recording it as `lost` and deleting its file is the job of the CLI (`queue waiters`, `queue wait`) and of the daemon
 * start, so a GET (polled every 60 s by the menu figure) never writes. The id of a registration is not returned. Files that cannot be used are named in `warningText`;
 * a folder that cannot be listed throws an Error that names it and what to do.
 */
export function getWaiters(configDir: string, deps: WaitersDeps = {}): WaitersAnswer {
  const now = deps.now ?? Date.now;
  const scanned = listLiveWaiters(configDir, { now, ...(deps.isAlive !== undefined && { isAlive: deps.isAlive }), ...(deps.fs !== undefined && { fs: deps.fs }) });
  if (scanned.unreadable !== undefined) {
    throw new Error(scanned.unreadable);
  }
  const waiters = scanned.waiters.map((waiter) => row(waiter, now()));
  const warningText = warningsOf(scanned.problems);
  return {
    waiters,
    count: waiters.length,
    staleCount: waiters.filter((waiter) => waiter.stale).length,
    anonymousCount: waiters.filter((waiter) => waiter.anonymous).length,
    ...(warningText !== undefined && { warningText }),
  };
}
