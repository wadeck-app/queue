/** How the waits are shown in a terminal and in `--json`: `queue waiters`, `queue waiters --history`, and the "Waiting now" section of the subscriber lists. */

import { WAITER_STALE_AFTER_MS, type LiveWaiter, type WaitRow } from '@wadeck-app/queue-core';
import { isAnonymousWaitName } from './waitSession.js';
import { formatUptime } from './relayStatusView.js';

// Names, filters, labels and paths come from files another process wrote: no control character may reach a terminal
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
export function printable(text: string): string {
  return text.replace(CONTROL, '');
}

/** What `queue waiters --json` prints for a live wait (an array of these). The wake contact: `pipe` (the daemon wakes the wait) or `none` (polling only). */
export interface LiveWaiterView {
  id: string;
  name: string;
  /** True when the wait was not given a name (`anon.<pid>`). */
  anonymous: boolean;
  events: string[];
  whens: string[];
  label: string;
  contact: 'none' | 'pipe';
  pid: number;
  cwd: string;
  since: string;
  startedAt: string;
  /** ISO time of the last heartbeat. */
  lastSeen: string;
  /** The last heartbeat is more than two periods old. */
  stale: boolean;
}

export function liveWaiterView(waiter: LiveWaiter, nowMs: number): LiveWaiterView {
  return {
    id: waiter.id,
    name: waiter.name,
    anonymous: isAnonymousWaitName(waiter.name),
    events: waiter.events,
    whens: waiter.whens,
    label: waiter.label,
    contact: waiter.contact.kind,
    pid: waiter.pid,
    cwd: waiter.cwd,
    since: waiter.since,
    startedAt: waiter.startedAt,
    lastSeen: new Date(waiter.lastSeenMs).toISOString(),
    stale: nowMs - waiter.lastSeenMs > WAITER_STALE_AFTER_MS,
  };
}

/** `5s`, `2m 3s`, `1h 4m` (never negative). */
export function span(ms: number): string {
  return formatUptime(Math.max(0, Math.floor(ms / 1000)));
}

const isoSeconds = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19)}Z`;

function forWhat(row: { events: readonly string[]; whens: readonly string[] }): string {
  const events = row.events.join(', ');
  return row.whens.length === 0 ? events : `${events} where ${row.whens.join(' and ')}`;
}

/** Columns padded to the widest cell; the text of each cell is made printable. */
function table(header: readonly string[], rows: readonly string[][]): string[] {
  const cells = [header, ...rows].map((row) => row.map(printable));
  const widths = header.map((_, column) => Math.max(...cells.map((row) => row[column]!.length)));
  return cells.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()}`);
}

/** The table of live waits, with its heading. */
export function liveWaitersText(views: readonly LiveWaiterView[], nowMs: number): string {
  const rows = views.map((view) => [
    view.anonymous ? `${view.name} (no --name)` : view.name,
    forWhat(view),
    view.label === '' ? '-' : view.label,
    view.contact === 'none' ? 'polling only' : view.contact,
    `${span(nowMs - Date.parse(view.startedAt))} ago`,
    `${span(nowMs - Date.parse(view.lastSeen))} ago${view.stale ? ' (stale)' : ''}`,
    String(view.pid),
  ]);
  return [`Waiting now (${views.length}):`, ...table(['NAME', 'FOR', 'LABEL', 'CONTACT', 'SINCE', 'LAST SEEN', 'PID'], rows)].join('\n') + '\n';
}

/** The table of past waits (newest first). `waiting` has no end; a `lost` wait whose sweep has not run has no end either. */
export function waitHistoryText(rows: readonly WaitRow[], nowMs: number): string {
  const lines = rows.map((row) => [
    isAnonymousWaitName(row.name) ? `${row.name} (no --name)` : row.name,
    forWhat(row),
    isoSeconds(row.startedAt),
    row.endedAt === undefined ? '-' : isoSeconds(row.endedAt),
    row.durationMs !== undefined ? span(row.durationMs) : row.outcome === 'waiting' ? span(nowMs - Date.parse(row.startedAt)) : '?',
    row.outcome,
    row.event !== undefined && row.eventId !== undefined ? `${row.event} (${row.eventId})` : '-',
  ]);
  return table(['NAME', 'FOR', 'FROM', 'TO', 'DURATION', 'OUTCOME', 'MATCHED'], lines).join('\n') + '\n';
}
