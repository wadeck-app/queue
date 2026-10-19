import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogFormatter } from './LogFormatter.js';

export interface LogTail {
  /** Day of the log file (UTC, YYYY-MM-DD). */
  date: string;
  file: string;
  /** False when nothing was logged that day (no file). */
  present: boolean;
  /** The last `limit` records, rendered by LogFormatter. */
  lines: string[];
  /** Records of that day that did not fit in `limit`. */
  omitted: number;
  /** Size of the file when it was read: where to continue from to follow it. */
  bytes: number;
}

export interface LogTailOptions {
  /** Most records returned; Infinity for all of the day. */
  limit: number;
  /** YYYY-MM-DD, default today (UTC). */
  date?: string;
  now?: () => Date;
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** A day as YYYY-MM-DD, the form of a log file name. */
export function isLogDate(value: string): boolean {
  return DATE_FORMAT.test(value);
}

export function logFilePath(configDir: string, date: string): string {
  return join(configDir, 'logs', `${date}.ndjson`);
}

/** A bad date throws: it becomes part of a file name, and an empty answer would read as "nothing happened that day". */
export function readLogTail(configDir: string, options: LogTailOptions): LogTail {
  const date = options.date ?? (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  if (!isLogDate(date)) {
    throw new Error(`Invalid log date "${date}": expected YYYY-MM-DD.`);
  }
  const file = logFilePath(configDir, date);
  if (!existsSync(file)) {
    return { date, file, present: false, lines: [], omitted: 0, bytes: 0 };
  }
  const content = readFileSync(file, 'utf8');
  const rendered = content.split('\n').map((line) => LogFormatter.format(line)).filter((line) => line !== '');
  const omitted = Math.max(0, rendered.length - options.limit);
  return {
    date,
    file,
    present: true,
    lines: omitted > 0 ? rendered.slice(omitted) : rendered,
    omitted,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}
