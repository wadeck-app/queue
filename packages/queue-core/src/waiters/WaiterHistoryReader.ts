import { join } from 'node:path';
import { parseLogDay } from '../storage/LogRetention.js';
import { waiterHistoryDir, type WaiterOutcome } from './WaiterHistory.js';
import { defaultWaiterFs, errorCode, errorText, type WaiterFs } from './WaiterLiveness.js';
import { listLiveWaiters } from './WaiterScan.js';
import type { WaiterRecord } from './WaiterRecord.js';

export type WaitRowOutcome = WaiterOutcome | 'waiting';

/** One wait: who, from when to when, how it ended. `waiting`: still running. A `lost` wait whose sweep has not run yet has no `endedAt`. */
export type WaitRow = Omit<WaiterRecord, 'v'> & {
  endedAt?: string;
  durationMs?: number;
  outcome: WaitRowOutcome;
  eventId?: string;
  event?: string;
};

export interface ReadWaiterHistoryOptions {
  /** Epoch ms: waits that ended at or after it, and the ones still waiting. */
  since?: number;
  /** A name, where `*` stands for any characters. */
  name?: string;
  outcome?: WaitRowOutcome;
  /** Default {@link DEFAULT_WAITER_HISTORY_LIMIT}. The newest are kept. */
  limit?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  fs?: Partial<WaiterFs>;
}

export interface WaiterHistoryRead {
  /** Newest start first. */
  rows: WaitRow[];
  /** Lines that were torn or not a record. */
  skippedLines: number;
  /** Files that could not be read, with the path. */
  problems: string[];
}

export const DEFAULT_WAITER_HISTORY_LIMIT = 100;
/** The day files read at most in one call. */
export const MAX_HISTORY_DAY_FILES = 100;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nameMatcher(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A `start` line as a row, undefined when it lacks what a row needs. */
function toStart(line: Fields): Omit<WaiterRecord, 'v'> | undefined {
  const { id, name, events, whens, label, contact, pid, cwd, since, startedAt } = line;
  if (typeof id !== 'string' || typeof name !== 'string' || !stringArray(events) || !stringArray(whens) || typeof label !== 'string' || !isFields(contact) || typeof pid !== 'number' || typeof cwd !== 'string' || typeof since !== 'string' || typeof startedAt !== 'string') {
    return undefined;
  }
  return { id, name, events, whens, label, contact: { kind: contact['kind'] === 'pipe' ? 'pipe' : 'none' }, pid, cwd, since, startedAt };
}

interface EndLine {
  endedAt: string;
  durationMs: number;
  outcome: WaiterOutcome;
  eventId?: string;
  event?: string;
}

function toEnd(line: Fields): ({ id: string } & EndLine) | undefined {
  const { id, endedAt, durationMs, outcome, eventId, event } = line;
  if (typeof id !== 'string' || typeof endedAt !== 'string' || typeof durationMs !== 'number' || typeof outcome !== 'string') {
    return undefined;
  }
  return { id, endedAt, durationMs, outcome: outcome as WaiterOutcome, ...(typeof eventId === 'string' && { eventId }), ...(typeof event === 'string' && { event }) };
}

/**
 * The waits history: the `start` and `end` records of `waiters/history/<day>.ndjson` paired into rows. A pruned day, a torn line and a line that is not a record are
 * tolerated (counted or reported, never thrown). Day files are read newest first: back to the day of `since`, and further only while an `end` still lacks its start.
 */
export function readWaiterHistory(configDir: string, options: ReadWaiterHistoryOptions = {}): WaiterHistoryRead {
  const now = options.now ?? Date.now;
  const fs = { ...defaultWaiterFs, ...options.fs };
  const dir = waiterHistoryDir(configDir);
  const result: WaiterHistoryRead = { rows: [], skippedLines: 0, problems: [] };

  let days: Array<{ day: string; name: string }>;
  try {
    days = fs.readdir(dir)
      .flatMap((name) => {
        const day = DAY_FILE.exec(name)?.[1];
        return day !== undefined && parseLogDay(day) !== undefined ? [{ day, name }] : [];
      })
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      result.problems.push(`could not list ${dir}: ${errorText(error)}. Fix: check that the folder is readable by this user.`);
    }
    return result;
  }

  const sinceDay = options.since === undefined ? undefined : new Date(options.since).toISOString().slice(0, 10);
  const starts = new Map<string, Omit<WaiterRecord, 'v'>>();
  const ends = new Map<string, EndLine>();
  let unpaired = 0;
  let filesRead = 0;
  for (const { day, name } of days) {
    if (sinceDay !== undefined && day < sinceDay && unpaired === 0) {
      break;
    }
    if (filesRead >= MAX_HISTORY_DAY_FILES) {
      result.problems.push(`only the newest ${MAX_HISTORY_DAY_FILES} day files of ${dir} were read.`);
      break;
    }
    filesRead++;
    const path = join(dir, name);
    let text: string;
    try {
      text = fs.readFile(path);
    } catch (error) {
      // Pruned under us: not a problem
      if (errorCode(error) !== 'ENOENT') {
        result.problems.push(`${path} could not be read (${errorText(error)}). Fix: check that the file is readable by this user.`);
      }
      continue;
    }
    for (const raw of text.split('\n')) {
      if (raw === '') {
        continue;
      }
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        result.skippedLines++;
        continue;
      }
      if (!isFields(line)) {
        result.skippedLines++;
        continue;
      }
      if (line['kind'] === 'start') {
        const start = toStart(line);
        if (start === undefined) {
          result.skippedLines++;
        } else {
          starts.set(start.id, start);
          if (ends.has(start.id)) {
            unpaired--;
          }
        }
      } else if (line['kind'] === 'end') {
        const end = toEnd(line);
        if (end === undefined) {
          result.skippedLines++;
        } else {
          const { id, ...fields } = end;
          if (!ends.has(id)) {
            ends.set(id, fields);
            if (!starts.has(id)) {
              unpaired++;
            }
          }
        }
      } else {
        result.skippedLines++;
      }
    }
  }

  const live = new Set(listLiveWaiters(configDir, { now, ...(options.isAlive !== undefined && { isAlive: options.isAlive }), fs: options.fs }).waiters.map((waiter) => waiter.id));
  const matchesName = options.name === undefined ? undefined : nameMatcher(options.name);
  const limit = options.limit ?? DEFAULT_WAITER_HISTORY_LIMIT;
  const rows: WaitRow[] = [];
  for (const start of starts.values()) {
    const end = ends.get(start.id);
    const row: WaitRow = { ...start, ...(end !== undefined ? end : {}), outcome: end?.outcome ?? (live.has(start.id) ? 'waiting' : 'lost') };
    if (matchesName !== undefined && !matchesName.test(row.name)) {
      continue;
    }
    if (options.outcome !== undefined && row.outcome !== options.outcome) {
      continue;
    }
    if (options.since !== undefined && row.outcome !== 'waiting' && Date.parse(row.endedAt ?? row.startedAt) < options.since) {
      continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  result.rows = rows.slice(0, limit);
  return result;
}
