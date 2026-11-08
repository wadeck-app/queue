import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine } from '../storage/AppendLine.js';
import { describeRetention, pruneLogDir, type PruneOptions, type PruneReport, type RetentionLine } from '../storage/LogRetention.js';
import type { WaiterRecord } from './WaiterRecord.js';

/** `<configDir>/waiters`: the live waiter files, the registration lock and the waits history. */
export function waitersDir(configDir: string): string {
  return join(configDir, 'waiters');
}

/** `<configDir>/waiters/history`: one `<UTC day>.ndjson` journal per day. */
export function waiterHistoryDir(configDir: string): string {
  return join(waitersDir(configDir), 'history');
}

/**
 * How a wait ended. `matched`: the event that satisfied it (`eventId`, `event`). `timeout`. `cancelled`: SIGINT, SIGTERM or `exit`. `refused`: the name was taken (exit 4).
 * `lost`: nobody wrote an `end` (the process was killed, or the machine slept); written by whoever sweeps the stale file, `endedAt` is its last heartbeat.
 */
export const WAITER_OUTCOMES = ['matched', 'timeout', 'cancelled', 'refused', 'lost'] as const;
export type WaiterOutcome = (typeof WAITER_OUTCOMES)[number];

export type WaiterStartRecord = { kind: 'start' } & Omit<WaiterRecord, 'v'>;

export interface WaiterEndRecord {
  kind: 'end';
  id: string;
  name: string;
  endedAt: string;
  durationMs: number;
  outcome: WaiterOutcome;
  /** For `matched`: the event that satisfied the wait. */
  eventId?: string;
  event?: string;
}

export interface WaiterHistoryOptions {
  now?: () => Date;
  /** Receives what the retention did or could not do. Default: stderr, so a problem is never silent. */
  onRetention?: (lines: RetentionLine[]) => void;
  /** The retention, replaceable for tests. */
  prune?: (dir: string, options: PruneOptions) => PruneReport;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The waits history: `start` and `end` records of every `queue wait` that registered, newest day last. Append-only (the shared `appendLine`, torn tail healed).
 * Kept like the event history (90 days, the same size budget) by the shared retention, which runs when the file of a new day is created. No payload is ever stored.
 * The file of a record is the day it is WRITTEN: a record about a wait of yesterday (a sweep) never recreates a pruned day.
 */
export class WaiterHistoryLog {
  private readonly now: () => Date;
  private readonly onRetention: (lines: RetentionLine[]) => void;
  private readonly prune: (dir: string, options: PruneOptions) => PruneReport;

  constructor(private readonly historyDir: string, options: WaiterHistoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onRetention = options.onRetention ?? ((lines) => {
      for (const line of lines) process.stderr.write(`[queue] ${line.message}\n`);
    });
    this.prune = options.prune ?? pruneLogDir;
  }

  recordStart(record: WaiterRecord): void {
    const { v: _version, ...fields } = record;
    this.write({ kind: 'start', ...fields } satisfies WaiterStartRecord);
  }

  recordEnd(end: WaiterEndRecord): void {
    this.write(end);
  }

  /** True when an `end` with this id exists in the files from the day `startedAt` falls in to today. Never throws: an unreadable file or line counts as "no end". */
  hasEnd(id: string, startedAt: string): boolean {
    const from = startedAt.slice(0, 10);
    const to = utcDay(this.now());
    let names: string[];
    try {
      names = readdirSync(this.historyDir);
    } catch {
      return false;
    }
    for (const name of names.sort()) {
      const day = DAY_FILE.exec(name)?.[1];
      if (day === undefined || day < from || day > to) {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(join(this.historyDir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes(id)) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { kind?: unknown; id?: unknown };
          if (parsed.kind === 'end' && parsed.id === id) {
            return true;
          }
        } catch {
          // a torn line
        }
      }
    }
    return false;
  }

  private write(entry: object): void {
    if (!existsSync(this.historyDir)) {
      mkdirSync(this.historyDir, { recursive: true });
    }
    const day = utcDay(this.now());
    const file = join(this.historyDir, `${day}.ndjson`);
    // A new day's file is the one moment the retention runs (not on every write)
    if (!existsSync(file)) {
      this.runRetention(day);
    }
    appendLine(file, JSON.stringify(entry) + '\n');
  }

  /** Never throws: a retention problem must not lose a record. */
  private runRetention(day: string): void {
    try {
      const report = this.prune(this.historyDir, { kind: 'history', now: this.now(), keepDay: day });
      const lines = describeRetention('Waits history', report);
      if (lines.length > 0) {
        this.onRetention(lines);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.onRetention([{ level: 'warn', message: `Waits history retention failed: ${message}. Check that ${this.historyDir} is readable; old waits are not pruned until the next new day.` }]);
      } catch {
        // The report channel itself failed: nothing left to tell, and the record must still be written
      }
    }
  }
}
