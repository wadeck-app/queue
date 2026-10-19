import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface HistorySubscriberOutcome {
  subscriberId: string;
  status: 'success' | 'failed' | 'dlq' | 'filtered';
  /** Resolved command or URL for success/failed/dlq outcomes. */
  target?: string;
  /** The raw `when:` expression, for filtered outcomes. */
  filter?: string;
  actual?: string;
}

export interface HistoryEntry {
  ts: string;
  eventId: string;
  event: string;
  project?: string;
  /** Subscribers configured for this event, before the `when:` filter was applied. Absent for orphan entries, see below. */
  totalCount?: number;
  /** Subscribers that passed the `when:` filter and were actually dispatched. Absent for orphan entries. */
  matchedCount?: number;
  subscribers: HistorySubscriberOutcome[];
  /** True when no `trigger` record was found for this eventId (e.g. a retry, which reuses the WAL entry id rather than the original push's eventId). */
  orphan: boolean;
  /** Original push payload, so `queue replay <eventId>` can resubmit it unchanged. Absent for orphan entries. */
  payload?: unknown;
  /** Set when this trigger was created by `queue replay`, pointing at the eventId it replays. */
  replayOf?: string;
  /** Working directory of the original push; absent for entries recorded before this field existed and for orphan entries. */
  cwd?: string;
}

export interface HistoryFilter {
  event?: string;
  subscriberId?: string;
  status?: 'success' | 'failed' | 'dlq' | 'filtered';
  sinceMs?: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Total entries matching the filter, before slicing -- for a "Showing X-Y of Z" footer. */
  total: number;
  limit: number;
  offset: number;
}

/** Matches flow-cli's HistoryCommand.ts convention (-n/--limit, --offset, same default) -- history
 * pagination should look the same across every CLI in the fleet, not reinvent a shape per project. */
export const DEFAULT_HISTORY_LIMIT = 20;

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
// `ts` and `type` are the first keys of every record; a raw quote cannot appear inside a JSON string value (it is
// escaped), so finding both in the head of the line cannot be fooled by a payload or a command text further on.
const LINE_HEAD_CHARS = 120;
const TS_KEY = /"ts":"([^"]+)"/;
const RECORD_TYPE = /"type":"(trigger|outcome|filtered)"/;
// Outcome lines are small (no payload) and write `status` before the free-text `target`, so the first match is the status
const OUTCOME_STATUS = /"status":"(success|failed|dlq)"/;

interface Accumulator {
  ts?: string;
  eventId: string;
  event?: string;
  project?: string;
  totalCount?: number;
  matchedCount?: number;
  payload?: unknown;
  replayOf?: string;
  cwd?: string;
  subscribers: HistorySubscriberOutcome[];
}

export class HistoryReader {
  // Keyed by filename, so `queue history --follow` -- which holds one reader across many
  // polls -- only re-reads/re-parses a day file once its mtime actually changes, instead of
  // paying full directory I/O + JSON.parse on every tick as history grows.
  private readonly fileCache = new Map<string, { mtimeMs: number; records: Record<string, unknown>[] }>();

  constructor(private readonly historyDir: string) {}

  read(filter: HistoryFilter = {}): HistoryEntry[] {
    const acc = new Map<string, Accumulator>();

    for (const file of this.listFiles()) {
      for (const record of this.readFileRecords(file)) {
        this.applyRecord(acc, record);
      }
    }

    const entries: HistoryEntry[] = Array.from(acc.values()).map(a => ({
      ts: a.ts ?? new Date(0).toISOString(),
      eventId: a.eventId,
      event: a.event ?? '(unknown)',
      project: a.project,
      totalCount: a.totalCount,
      matchedCount: a.matchedCount,
      subscribers: a.subscribers,
      orphan: a.totalCount === undefined,
      payload: a.payload,
      replayOf: a.replayOf,
      cwd: a.cwd,
    }));

    return entries
      .filter(e => this.matches(e, filter))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** Looks up a single entry by its exact eventId, for `queue replay <eventId>`. */
  findByEventId(eventId: string): HistoryEntry | undefined {
    return this.read().find(e => e.eventId === eventId);
  }

  /**
   * Paginated read, newest-first -- the default entry point for any one-shot listing (CLI or
   * HTTP). `--follow`/live-tail intentionally bypasses this and calls `read()` directly: tailing
   * and paging are different operations (same split flow-cli and task-cli both make), slicing a
   * live tail by page would just make entries disappear as new ones arrive.
   */
  readPage(filter: HistoryFilter = {}, pagination: { limit?: number; offset?: number } = {}): HistoryPage {
    const limit = pagination.limit ?? DEFAULT_HISTORY_LIMIT;
    const offset = pagination.offset ?? 0;
    const all = this.read(filter);
    return { entries: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  /**
   * How many events were pushed in each of the last `windowsMs` before `nowMs` (one count per window, same order).
   * An event is one `trigger` record. Reads only the day files the widest window reaches and matches the line
   * head of the line instead of parsing it: a day file holds the full webhook payloads (18 MB in a busy day), so a
   * dashboard counter must not pay a JSON.parse per line. Relies on HistoryLog writing `ts` and `type` first (a test
   * writes through HistoryLog to guard it). An unreadable line is skipped.
   */
  countTriggers(nowMs: number, windowsMs: number[]): number[] {
    const counts = windowsMs.map(() => 0);
    if (windowsMs.length === 0) {
      return counts;
    }
    this.forEachTrigger(nowMs, Math.max(...windowsMs), (ts) => {
      windowsMs.forEach((window, i) => {
        if (ts >= nowMs - window) {
          counts[i]!++;
        }
      });
    });
    return counts;
  }

  /**
   * How many events were pushed in each of the last `bucketCount` buckets of `bucketMs`, oldest first. The buckets
   * are aligned on the local clock (a one-hour bucket starts on the hour) and the last one is the current, partial
   * one: `startMs` is the start of the first bucket. Same cost and same line matching as {@link countTriggers}.
   */
  bucketTriggers(nowMs: number, bucketMs: number, bucketCount: number): { startMs: number; counts: number[] } {
    const counts = new Array<number>(bucketCount).fill(0);
    const offsetMs = -new Date(nowMs).getTimezoneOffset() * 60_000;
    const currentStartMs = Math.floor((nowMs + offsetMs) / bucketMs) * bucketMs - offsetMs;
    const startMs = currentStartMs - (bucketCount - 1) * bucketMs;
    this.forEachTrigger(nowMs, nowMs - startMs, (ts) => {
      if (ts >= startMs) {
        counts[Math.floor((ts - startMs) / bucketMs)]!++;
      }
    });
    return { startMs, counts };
  }

  /** Calls `visit` with the time of every trigger record in the `lookbackMs` before `nowMs` (and none after it). */
  private forEachTrigger(nowMs: number, lookbackMs: number, visit: (ts: number) => void): void {
    this.forEachRecord('trigger', nowMs, lookbackMs, (ts) => visit(ts));
  }

  /** Calls `visit` with the time and the raw line of every record of that type in the `lookbackMs` before `nowMs`. */
  private forEachRecord(type: 'trigger' | 'outcome' | 'filtered', nowMs: number, lookbackMs: number, visit: (ts: number, line: string) => void): void {
    const oldestDay = new Date(nowMs - lookbackMs).toISOString().slice(0, 10);
    for (const file of this.listFiles()) {
      if (file.slice(0, 10) < oldestDay) {
        continue;
      }
      for (const line of readFileSync(join(this.historyDir, file), 'utf-8').split('\n')) {
        const head = line.slice(0, LINE_HEAD_CHARS);
        const tsMatch = TS_KEY.exec(head);
        const typeMatch = RECORD_TYPE.exec(head);
        if (!tsMatch || typeMatch?.[1] !== type) {
          continue;
        }
        const ts = Date.parse(tsMatch[1]!);
        if (Number.isNaN(ts) || ts > nowMs) {
          continue;
        }
        visit(ts, line);
      }
    }
  }

  /**
   * How many dispatches ended in each way in each of the last `bucketCount` buckets of `bucketMs` (aligned like
   * {@link bucketTriggers}): `success`, `failed` (one attempt failed, a retry follows) and `dlq` (given up).
   * Reads the small outcome lines only, never a payload.
   */
  bucketOutcomes(nowMs: number, bucketMs: number, bucketCount: number): { startMs: number; success: number[]; failed: number[]; dlq: number[] } {
    const counts = { success: new Array<number>(bucketCount).fill(0), failed: new Array<number>(bucketCount).fill(0), dlq: new Array<number>(bucketCount).fill(0) };
    const offsetMs = -new Date(nowMs).getTimezoneOffset() * 60_000;
    const startMs = Math.floor((nowMs + offsetMs) / bucketMs) * bucketMs - offsetMs - (bucketCount - 1) * bucketMs;
    this.forEachRecord('outcome', nowMs, nowMs - startMs, (ts, line) => {
      const status = OUTCOME_STATUS.exec(line)?.[1] as 'success' | 'failed' | 'dlq' | undefined;
      if (ts >= startMs && status !== undefined) {
        counts[status][Math.floor((ts - startMs) / bucketMs)]!++;
      }
    });
    return { startMs, ...counts };
  }

  private listFiles(): string[] {
    if (!existsSync(this.historyDir)) {
      return [];
    }
    return readdirSync(this.historyDir).filter(f => DATE_FILE.test(f)).sort();
  }

  private readFileRecords(file: string): Record<string, unknown>[] {
    const filePath = join(this.historyDir, file);
    // Rounded: utimes/stat round-trips can shift sub-millisecond precision on some
    // filesystems even with no real content change, which would defeat the cache.
    const mtimeMs = Math.round(statSync(filePath).mtimeMs);
    const cached = this.fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.records;
    }

    const content = readFileSync(filePath, 'utf-8');
    const records: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        records.push(JSON.parse(trimmed));
      } catch (err) {
        throw new Error(`Malformed history record in ${file}: ${trimmed} (${(err as Error).message})`);
      }
    }
    this.fileCache.set(file, { mtimeMs, records });
    return records;
  }

  private applyRecord(acc: Map<string, Accumulator>, record: Record<string, unknown>): void {
    const eventId = record['eventId'] as string | undefined;
    if (!eventId) {
      return;
    }
    const entry = acc.get(eventId) ?? { eventId, subscribers: [] };
    acc.set(eventId, entry);

    const ts = record['ts'] as string | undefined;
    const type = record['type'] as string | undefined;

    if (type === 'trigger') {
      entry.ts = ts;
      entry.event = record['event'] as string;
      entry.project = record['project'] as string | undefined;
      entry.matchedCount = record['matchedCount'] as number;
      entry.totalCount = record['totalCount'] as number;
      entry.payload = record['payload'];
      entry.replayOf = record['replayOf'] as string | undefined;
      entry.cwd = record['cwd'] as string | undefined;
      return;
    }
    if (type === 'outcome') {
      entry.ts = entry.ts ?? ts;
      entry.event = entry.event ?? (record['event'] as string);
      entry.subscribers.push({
        subscriberId: record['subscriberId'] as string,
        status: record['status'] as HistorySubscriberOutcome['status'],
        target: record['target'] as string | undefined,
      });
      return;
    }
    if (type === 'filtered') {
      entry.ts = entry.ts ?? ts;
      entry.event = entry.event ?? (record['event'] as string);
      entry.subscribers.push({
        subscriberId: record['subscriberId'] as string,
        status: 'filtered',
        filter: record['filter'] as string | undefined,
        actual: record['actual'] as string | undefined,
      });
    }
  }

  private matches(entry: HistoryEntry, filter: HistoryFilter): boolean {
    if (filter.event && entry.event !== filter.event) {
      return false;
    }
    if (filter.sinceMs !== undefined && Date.parse(entry.ts) < filter.sinceMs) {
      return false;
    }
    if (filter.subscriberId && !entry.subscribers.some(s => s.subscriberId === filter.subscriberId)) {
      return false;
    }
    if (filter.status && !entry.subscribers.some(s => s.status === filter.status)) {
      return false;
    }
    return true;
  }
}
