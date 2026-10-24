import { existsSync, readFileSync } from 'node:fs';
import { isRecord } from '../isRecord.js';
import { isLogDate, logFilePath } from './LogReader.js';

// The dispatch log as structured records, for a dashboard that shows one short row per record and the whole record on demand.
// `LogFormatter` stays the rendering of `queue logs`; this is the same files read as data. A record that cannot be read is
// kept visible (outcome `info`) instead of being dropped: a diagnostic nobody sees is lost.

/** `ok` ran a subscriber, `miss` skipped it (its filter did not match), `fail` an attempt failed, `dlq` given up, `info` anything else. */
export const LOG_OUTCOMES = ['ok', 'miss', 'fail', 'dlq', 'info'] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

export interface LogRecord {
  /** ISO timestamp of the record. */
  ts: string;
  /** HH:MM:SS of the record (UTC, as stored). */
  time: string;
  outcome: LogOutcome;
  /** The event the record is about; the source of a diagnostic; `cli` for a CLI invocation. */
  event: string;
  subscriberId?: string;
  /** The whole record as written. */
  entry: Record<string, unknown>;
}

/** `on.github.push[0]` -> `on.github.push`: a subscriber id is the event name and the index of the subscriber. */
export function eventOfSubscriber(subscriberId: string): string {
  return subscriberId.replace(/\[\d+\]$/, '');
}

function timeOf(ts: unknown): string {
  return typeof ts === 'string' && ts.length >= 19 ? ts.slice(11, 19) : '??:??:??';
}

/** One NDJSON line of the log, or undefined for a blank line. */
export function parseLogRecord(raw: string): LogRecord | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return { ts: '', time: '??:??:??', outcome: 'info', event: '(unreadable line)', entry: { raw: trimmed } };
  }
  if (!isRecord(entry)) {
    return { ts: '', time: '??:??:??', outcome: 'info', event: '(unreadable line)', entry: { raw: trimmed } };
  }
  const ts = typeof entry['ts'] === 'string' ? entry['ts'] : '';
  const time = timeOf(entry['ts']);
  const subscriberId = typeof entry['subscriberId'] === 'string' ? entry['subscriberId'] : undefined;
  const base = { ts, time, entry, ...(subscriberId !== undefined && { subscriberId }) };
  const event = subscriberId !== undefined ? eventOfSubscriber(subscriberId) : undefined;

  if (typeof entry['msg'] === 'string') {
    return { ...base, outcome: 'info', event: 'cli' };
  }
  if (entry['type'] === 'dispatch') {
    const status = entry['status'];
    const outcome: LogOutcome = status === 'success' ? 'ok' : status === 'failed' ? 'fail' : status === 'dlq' ? 'dlq' : 'info';
    return { ...base, outcome, event: event ?? '(unknown event)' };
  }
  if (entry['type'] === 'filter-miss') {
    return { ...base, outcome: 'miss', event: event ?? '(unknown event)' };
  }
  if (entry['type'] === 'diagnostic') {
    return { ...base, outcome: 'info', event: typeof entry['source'] === 'string' ? entry['source'] : '(diagnostic)' };
  }
  return { ...base, outcome: 'info', event: typeof entry['type'] === 'string' ? entry['type'] : '(unknown record)' };
}

export interface LogRecordsOptions {
  /** YYYY-MM-DD, default today (UTC). */
  date?: string;
  /** Most records returned (the newest ones). */
  limit: number;
  /** Only the records with this outcome. */
  outcome?: LogOutcome;
  /** Only the records whose event contains this text (case-insensitive). */
  event?: string;
  now?: () => Date;
}

export interface LogRecords {
  date: string;
  /** False when nothing was logged that day (no file). */
  present: boolean;
  /** Records that match the filter and did not fit in `limit`. */
  omitted: number;
  /** Newest first. */
  records: LogRecord[];
}

/** The records of a day matching `outcome` and `event`, newest first, at most `limit`. The filters apply before the limit. */
export function readLogRecords(configDir: string, options: LogRecordsOptions): LogRecords {
  const date = options.date ?? (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  if (!isLogDate(date)) {
    throw new Error(`Invalid log date "${date}": expected YYYY-MM-DD.`);
  }
  const file = logFilePath(configDir, date);
  if (!existsSync(file)) {
    return { date, present: false, omitted: 0, records: [] };
  }
  const wanted = options.event?.toLowerCase();
  const matching = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => parseLogRecord(line))
    .filter((record): record is LogRecord => record !== undefined)
    .filter((record) => (options.outcome === undefined || record.outcome === options.outcome) && (wanted === undefined || record.event.toLowerCase().includes(wanted)));
  const omitted = Math.max(0, matching.length - options.limit);
  return { date, present: true, omitted, records: matching.slice(omitted).reverse() };
}
