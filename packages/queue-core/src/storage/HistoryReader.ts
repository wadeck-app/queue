import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CausedBy } from './HistoryLog.js';

export interface HistorySubscriberOutcome {
  subscriberId: string;
  status: 'success' | 'failed' | 'dlq' | 'filtered';
  /** Resolved command or URL for success/failed/dlq outcomes. */
  target?: string;
  /** The raw `when:` expression, for filtered outcomes. */
  filter?: string;
  actual?: string;
  /** The project the dispatch was filed under; with `to-children` the descendant's. Absent before this field existed and for events of no registered project. */
  projectId?: string;
  /** Set with `to-children`: the project the event was emitted in. */
  emitterProjectId?: string;
}

export interface HistoryEntry {
  ts: string;
  eventId: string;
  event: string;
  project?: string;
  /** Id of the registered project (project-sdk) of the push; absent when its working directory was in no registered project, and before this field existed. */
  projectId?: string;
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
  /** Working directory of the original push; absent for entries recorded before this field existed, for orphan entries and for the events of a project without folder. */
  cwd?: string;
  /** The `direction` of the original push when it was not the default (`to-parents`), so a replay propagates the same way. */
  direction?: string[];
  /** Set when an action subscriber emitted this event (machine-generated): the event and the subscriber that caused it. Absent for a pushed event. */
  causedBy?: CausedBy;
}

/** The trigger record of an event as written to the history: the push itself. */
export interface TriggerRecord {
  ts: string;
  eventId: string;
  event: string;
  /** Absent when the record holds none. */
  payload?: unknown;
  project?: string;
  projectId?: string;
  cwd?: string;
  replayOf?: string;
  direction?: string[];
  causedBy?: CausedBy;
}

export interface HistoryFilter {
  event?: string;
  /** Only the pushes of this registered project (its id). */
  projectId?: string;
  subscriberId?: string;
  status?: 'success' | 'failed' | 'dlq' | 'filtered';
  sinceMs?: number;
}

/** A day file holding lines that are not valid JSON (they are skipped, never fatal): how many, and the first one (truncated). */
export interface MalformedHistoryFile {
  /** File name, e.g. 2026-10-19.ndjson. */
  file: string;
  count: number;
  sample: string;
}

/** What {@link HistoryReader.readRecent} reads: the entries of one event name (or of the names a predicate accepts) recorded at or after `sinceMs`. */
export interface RecentHistoryFilter {
  /** An exact event name. */
  event?: string;
  /** Instead of `event`: every name `test` accepts (a subscribers.yml pattern); `key` identifies the predicate for the reader's cache (use the pattern text). */
  match?: { key: string; test: (eventName: string) => boolean };
  sinceMs: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** One sentence per file with malformed lines (they were skipped); absent when every line was readable. */
  warnings?: string[];
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
// `event` / `subscriberId` come right after `ts`, `type` and `eventId`, before any payload: look at the start of the line only
const KEY_SEARCH_CHARS = 400;
const EVENT_KEY = /"event":"((?:[^"\\]|\\.)*)"/;
const EVENT_ID_KEY = /"eventId":"((?:[^"\\]|\\.)*)"/;
// What precedes the type of a record in its line: the opening brace and the `ts` key HistoryLog writes first
const TRIGGER_LINE_HEAD = /^\{"ts":"[^"\\]*",$/;
const SUBSCRIBER_KEY = /"subscriberId":"((?:[^"\\]|\\.)*)"/;
// A day file is read in chunks of this size, never whole: a day of webhook payloads is tens of MB
const READ_CHUNK_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
// A malformed line is reported with its first characters only
const SAMPLE_CHARS = 120;
// What a record line starts with (HistoryLog writes `ts` first): a second one inside a line means two records were glued together
const RECORD_START = '{"ts":"';

/**
 * The malformed lines met by one operation, per file. `seen` (partial scans only) keeps a line met twice by the same operation (two passes over a file)
 * from being counted twice; a full scan visits every line once and needs none.
 */
interface Tally {
  files: Map<string, MalformedHistoryFile>;
  seen: Set<string> | undefined;
}

function newTally(partial: boolean): Tally {
  return { files: new Map(), seen: partial ? new Set() : undefined };
}

function noteMalformed(tally: Tally, file: string, line: string): void {
  const trimmed = line.trim();
  if (tally.seen !== undefined) {
    const key = `${file}\0${trimmed}`;
    if (tally.seen.has(key)) {
      return;
    }
    tally.seen.add(key);
  }
  const known = tally.files.get(file);
  if (known === undefined) {
    tally.files.set(file, { file, count: 1, sample: trimmed.slice(0, SAMPLE_CHARS) });
  } else {
    known.count++;
  }
}

/** One line of a day file as a record: undefined for an empty line, and for a line that is not JSON (which is noted in the tally, not thrown). */
function parseRecordLine(tally: Tally, file: string, line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    noteMalformed(tally, file, trimmed);
    return undefined;
  }
}

/** A JSON string body (still escaped) back to text. */
function unescapeJson(body: string): string {
  return body.includes('\\') ? (JSON.parse(`"${body}"`) as string) : body;
}

export interface EventActivity {
  /** Pushes of the event in the window. */
  count: number;
  /** Pushes of the event in the recent part of the window. */
  recentCount: number;
  /** Epoch ms of the last push. */
  lastSeenMs: number;
}

export interface OutcomeCounts {
  success: number;
  failed: number;
  dlq: number;
}

interface Accumulator {
  ts?: string;
  eventId: string;
  event?: string;
  project?: string;
  projectId?: string;
  totalCount?: number;
  matchedCount?: number;
  payload?: unknown;
  replayOf?: string;
  cwd?: string;
  direction?: string[];
  causedBy?: CausedBy;
  subscribers: HistorySubscriberOutcome[];
}

/**
 * Calls `visit` with every complete line (newline-terminated) of a file from byte `from`, reading it in chunks so that no more than one chunk and one line
 * are in memory. Returns the offset just after the last newline and the text after it (an unterminated last line; undefined when none).
 * Throws what the file system throws (ENOENT included).
 */
function forEachLine(path: string, from: number, visit: (line: string) => void): { consumed: number; tail: string | undefined } {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    // The parts of the line being read, when it spans chunks
    let pieces: Buffer[] = [];
    let position = from;
    let consumed = from;
    for (;;) {
      const read = readSync(fd, chunk, 0, READ_CHUNK_BYTES, position);
      if (read === 0) {
        break;
      }
      // What this read filled (the rest of the buffer holds the previous chunk)
      const data = chunk.subarray(0, read);
      let start = 0;
      for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
        const last = data.subarray(start, end);
        visit((pieces.length === 0 ? last : Buffer.concat([...pieces, last])).toString('utf-8'));
        pieces = [];
        consumed = position + end + 1;
        start = end + 1;
      }
      if (start < read) {
        // The chunk buffer is reused by the next read: keep a copy
        pieces.push(Buffer.from(data.subarray(start)));
      }
      position += read;
    }
    return { consumed, tail: pieces.length === 0 ? undefined : Buffer.concat(pieces).toString('utf-8') };
  } finally {
    closeSync(fd);
  }
}

/** What a reader keeps of one day file for one wanted name: the records of that name up to `consumed`, which is where the next read continues. */
interface RecentFileCache {
  mtimeMs: number;
  size: number;
  consumed: number;
  records: Record<string, unknown>[];
  malformed?: MalformedHistoryFile;
}

export class HistoryReader {
  // Keyed by filename, so `queue history --follow` -- which holds one reader across many
  // polls -- only re-reads/re-parses a day file once its mtime actually changes, instead of
  // paying full directory I/O + JSON.parse on every tick as history grows.
  private readonly fileCache = new Map<string, { mtimeMs: number; size: number; records: Record<string, unknown>[]; malformed?: MalformedHistoryFile }>();
  // What the operations met so far, per file: a line that is not valid JSON is skipped (it used to make every read throw, for as long as the file lived) and listed here
  private readonly malformedByFile = new Map<string, MalformedHistoryFile>();
  // Of readRecent: by day file and wanted name; and the ids already looked up in the days it left out (true: their trigger is there)
  private readonly recentCache = new Map<string, RecentFileCache>();
  private readonly olderTriggerKnown = new Map<string, boolean>();

  constructor(private readonly historyDir: string) {}

  /**
   * The day files in which an operation of this reader met lines that are not valid JSON (a write cut short by a crash, two records glued together, a hand edit),
   * oldest file first. Those lines are skipped and every other line is read normally, so check this after reading: it is how the skip is made visible.
   * A full read reports every such line; the targeted lookups (findTrigger, findByEventId, readProject) report the ones they came across.
   */
  malformedLines(): MalformedHistoryFile[] {
    return [...this.malformedByFile.values()].sort((a, b) => a.file.localeCompare(b.file)).map((m) => ({ ...m }));
  }

  /** {@link malformedLines} as one actionable sentence per file (with the path), for a CLI [warn] line or an API `warnings` field. */
  malformedWarnings(): string[] {
    return this.malformedLines().map(
      (m) =>
        `${join(this.historyDir, m.file)}: ${m.count} malformed line(s) skipped (first: ${m.sample}). A write interrupted by a crash most likely left it; every other line of the file is read normally. ` +
        `Repair or delete that line in the file if you do not need it.`,
    );
  }

  private commit(tally: Tally): void {
    for (const [file, malformed] of tally.files) {
      this.malformedByFile.set(file, malformed);
    }
  }

  read(filter: HistoryFilter = {}): HistoryEntry[] {
    const acc = new Map<string, Accumulator>();

    const files = this.listFiles();
    // A day the retention deleted must not stay in memory (nor be served) in a reader that lives across polls
    for (const cachedFile of [...this.fileCache.keys()]) {
      if (!files.includes(cachedFile)) {
        this.fileCache.delete(cachedFile);
      }
    }
    for (const reported of [...this.malformedByFile.keys()]) {
      if (!files.includes(reported)) {
        this.malformedByFile.delete(reported);
      }
    }
    for (const file of files) {
      for (const record of this.readFileRecords(file)) {
        this.applyRecord(acc, record);
      }
    }

    return this.toEntries(acc)
      .filter(e => this.matches(e, filter))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /**
   * The entries of one event name (or of the names a predicate accepts) at or after `sinceMs`, newest first: the same entries as
   * `read({ event, sinceMs })`, for a reader whose memory must not depend on the size of the history (`queue wait`, which holds one reader
   * for as long as it waits). What it does differently, on purpose:
   * - It opens only the day files from the UTC day before `sinceMs` on (a record is filed under the day of its time and an outcome follows its
   *   trigger, so nothing of an entry recorded since `sinceMs` is in an earlier file). The day before covers a push just before midnight.
   * - It reads them in chunks and parses only the lines whose name is wanted (the `event` key sits in the head of every record), so a line of
   *   another name is neither parsed nor kept, and a malformed one among them is not noticed (`read()` and `malformedLines()` report those).
   * - It keeps the parsed records of the wanted name by file, and a later read only reads what was appended since (the files are append-only).
   * An entry with outcomes only in the files it opened (a retry, or a late outcome of an older push) is checked once against the files it left
   * out, so that an old push whose outcome landed after `sinceMs` is left out, as `read()` does.
   */
  readRecent(filter: RecentHistoryFilter): HistoryEntry[] {
    const key = filter.event !== undefined ? `event:${filter.event}` : `match:${filter.match?.key ?? ''}`;
    const wanted = (name: string): boolean => (filter.event !== undefined ? name === filter.event : (filter.match?.test(name) ?? true));
    const files = this.listFiles();
    const firstDay = new Date(filter.sinceMs - DAY_MS).toISOString().slice(0, 10);
    const opened = files.filter((file) => file.slice(0, 10) >= firstDay);
    const left = files.filter((file) => file.slice(0, 10) < firstDay);
    for (const cached of [...this.recentCache.keys()]) {
      if (!opened.includes(cached.slice(0, cached.indexOf('\0')))) {
        this.recentCache.delete(cached);
      }
    }
    const acc = new Map<string, Accumulator>();
    const withTrigger = new Set<string>();
    for (const file of opened) {
      for (const record of this.recentRecords(file, key, wanted)) {
        this.applyRecord(acc, record);
        if (record['type'] === 'trigger' && typeof record['eventId'] === 'string') {
          withTrigger.add(record['eventId']);
        }
      }
    }
    if (left.length > 0) {
      for (const eventId of [...acc.keys()]) {
        if (!withTrigger.has(eventId) && this.hasTriggerIn(eventId, left)) {
          acc.delete(eventId);
        }
      }
    }
    return this.toEntries(acc)
      .filter((e) => this.matches(e, { sinceMs: filter.sinceMs }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** Whether the push of this id is in one of these day files (answered once per id: a trigger cannot appear later in a day that is over). */
  private hasTriggerIn(eventId: string, files: string[]): boolean {
    const known = this.olderTriggerKnown.get(eventId);
    if (known !== undefined) {
      return known;
    }
    const needle = Buffer.from(`"type":"trigger","eventId":${JSON.stringify(eventId)}`, 'utf-8');
    const found = this.scanForTrigger(eventId, needle, files, newTally(true)) !== undefined;
    this.olderTriggerKnown.set(eventId, found);
    return found;
  }

  /** The records of the wanted names in a day file: those kept from the earlier reads, plus what the file gained since. */
  private recentRecords(file: string, key: string, wanted: (name: string) => boolean): Record<string, unknown>[] {
    const path = join(this.historyDir, file);
    const cacheKey = `${file}\0${key}`;
    let mtimeMs: number;
    let size: number;
    try {
      const stat = statSync(path);
      mtimeMs = Math.round(stat.mtimeMs);
      size = stat.size;
    } catch (err) {
      // Deleted by the history retention since the directory was listed: see readDayFile
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recentCache.delete(cacheKey);
        return [];
      }
      throw err;
    }
    let cache = this.recentCache.get(cacheKey);
    if (cache !== undefined && cache.mtimeMs === mtimeMs && cache.size === size) {
      return cache.records;
    }
    // A file smaller than what was read of it was replaced, not appended to
    if (cache === undefined || size < cache.consumed) {
      cache = { mtimeMs, size, consumed: 0, records: [] };
    }
    const tally = newTally(false);
    const gained: Record<string, unknown>[] = [];
    const take = (line: string): void => {
      const body = EVENT_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
      if (body !== undefined && !wanted(unescapeJson(body))) {
        return;
      }
      const record = parseRecordLine(tally, file, line);
      if (record !== undefined) {
        gained.push(record);
      }
    };
    let result: { consumed: number; tail: string | undefined };
    try {
      result = forEachLine(path, cache.consumed, take);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.recentCache.delete(cacheKey);
        return [];
      }
      throw err;
    }
    const earlier = cache.malformed;
    const malformed = tally.files.get(file);
    const merged = malformed === undefined ? earlier : { ...malformed, count: malformed.count + (earlier?.count ?? 0), sample: earlier?.sample ?? malformed.sample };
    const kept: RecentFileCache = { mtimeMs, size, consumed: result.consumed, records: [...cache.records, ...gained], ...(merged !== undefined && { malformed: merged }) };
    this.recentCache.set(cacheKey, kept);
    if (merged !== undefined) {
      this.malformedByFile.set(file, merged);
    }
    // An unterminated last line is read now but not kept: it may be a write in progress, and is read again once it ends
    if (result.tail === undefined) {
      return kept.records;
    }
    const before = gained.length;
    take(result.tail);
    return gained.length > before ? [...kept.records, gained[gained.length - 1]!] : kept.records;
  }

  /**
   * The same entries as `read({ projectId })` (newest first), without paying a JSON.parse per line of every day file: a project that
   * ran nothing is the common case of a project page, and a full read of a busy history takes seconds. Pass 1 finds the event ids of the
   * lines that mention the id at all (a raw substring test, so a payload that merely contains the text only adds a candidate that
   * `matches` then rejects); pass 2 parses only the lines of those events, so the entry is complete wherever its records are.
   * Does not use the file cache: it is meant for one-shot reads.
   */
  readProject(projectId: string): HistoryEntry[] {
    // Bytes, not text: a search for an ASCII id needs no decoding, and a project with nothing in the history never decodes a file
    const files = this.listFiles().flatMap((file) => {
      const bytes = this.readDayFile(file);
      return bytes === undefined ? [] : [{ file, bytes }];
    });
    const needle = Buffer.from(projectId, 'utf-8');
    const tally = newTally(true);
    const candidates = new Set<string>();
    for (const { file, bytes } of files) {
      let from = 0;
      for (let hit = bytes.indexOf(needle, from); hit !== -1; hit = bytes.indexOf(needle, from)) {
        const lineStart = bytes.lastIndexOf(10, hit) + 1;
        const lineEnd = bytes.indexOf(10, hit);
        const line = bytes.toString('utf-8', lineStart, lineEnd === -1 ? bytes.length : lineEnd);
        const body = EVENT_ID_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
        const eventId = body !== undefined ? unescapeJson(body) : (parseRecordLine(tally, file, line)?.['eventId'] as string | undefined);
        if (eventId) {
          candidates.add(eventId);
        }
        // The rest of this line cannot add anything: go to the next one
        from = lineEnd === -1 ? bytes.length : lineEnd + 1;
      }
    }
    const acc = new Map<string, Accumulator>();
    if (candidates.size > 0) {
      for (const { file, bytes } of files) {
        for (const line of bytes.toString('utf-8').split('\n')) {
          const body = EVENT_ID_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
          if (body !== undefined && candidates.has(unescapeJson(body))) {
            const record = parseRecordLine(tally, file, line);
            if (record !== undefined) {
              this.applyRecord(acc, record);
            }
          }
        }
      }
    }
    this.commit(tally);
    return this.toEntries(acc)
      .filter(e => this.matches(e, { projectId }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  private toEntries(acc: Map<string, Accumulator>): HistoryEntry[] {
    return Array.from(acc.values()).map(a => ({
      ts: a.ts ?? new Date(0).toISOString(),
      eventId: a.eventId,
      event: a.event ?? '(unknown)',
      project: a.project,
      projectId: a.projectId,
      totalCount: a.totalCount,
      matchedCount: a.matchedCount,
      subscribers: a.subscribers,
      orphan: a.totalCount === undefined,
      payload: a.payload,
      replayOf: a.replayOf,
      cwd: a.cwd,
      ...(a.direction !== undefined && { direction: a.direction }),
      ...(a.causedBy !== undefined && { causedBy: a.causedBy }),
    }));
  }

  /**
   * The trigger record of an event (the push itself: name, payload, time, project), or undefined when the history holds none for that id
   * (never pushed, or older than the retention). Cheap on a large history: day files are scanned newest first as bytes, the id is
   * looked up as the byte needle `"type":"trigger","eventId":<id>` (the order HistoryLog writes, right after `ts`) and only the line of the
   * hit is parsed, so no other line of any file is. The needle also occurs in a payload holding an object with those keys in that order;
   * a hit counts only when it sits at the head of its line, and the parsed record is checked again, so a hostile payload cannot answer for
   * another event. The newest trigger wins, as in {@link read}. Does not use the file cache.
   */
  findTrigger(eventId: string): TriggerRecord | undefined {
    return this.locateTrigger(eventId)?.trigger;
  }

  private locateTrigger(eventId: string): { trigger: TriggerRecord; file: string; files: string[] } | undefined {
    // The id as it is written in the file (JSON-escaped, quotes included)
    const needle = Buffer.from(`"type":"trigger","eventId":${JSON.stringify(eventId)}`, 'utf-8');
    const files = this.listFiles();
    const tally = newTally(true);
    try {
      return this.scanForTrigger(eventId, needle, files, tally);
    } finally {
      this.commit(tally);
    }
  }

  private scanForTrigger(eventId: string, needle: Buffer, files: string[], tally: Tally): { trigger: TriggerRecord; file: string; files: string[] } | undefined {
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i]!;
      const bytes = this.readDayFile(file);
      if (bytes === undefined) {
        continue;
      }
      // Backwards inside the file too: the newest line first
      for (let hit = bytes.lastIndexOf(needle); hit !== -1; hit = hit === 0 ? -1 : bytes.lastIndexOf(needle, hit - 1)) {
        const lineStart = bytes.lastIndexOf(10, hit) + 1;
        if (!TRIGGER_LINE_HEAD.test(bytes.toString('utf-8', lineStart, hit))) {
          continue;
        }
        const lineEnd = bytes.indexOf(10, hit);
        // A hit on a torn line is skipped (and reported), the older hits and files are still searched
        const record = parseRecordLine(tally, file, bytes.toString('utf-8', lineStart, lineEnd === -1 ? bytes.length : lineEnd));
        if (record !== undefined && record['type'] === 'trigger' && record['eventId'] === eventId) {
          return { trigger: toTriggerRecord(record), file, files };
        }
      }
    }
    return undefined;
  }

  /**
   * Looks up a single entry by its exact eventId, for `queue replay <eventId>`: the same entry as `read().find(...)`, without parsing
   * every line of the history. Only the lines that carry the id are parsed; the day files before the trigger's day cannot hold a record of the
   * event, so they are not even searched. An id with no trigger (a retry's WAL id) is looked for in every day file and gives an orphan entry.
   * A malformed line that does not carry the id is not noticed (`read()` reports it).
   */
  findByEventId(eventId: string): HistoryEntry | undefined {
    const located = this.locateTrigger(eventId);
    const files = located === undefined ? this.listFiles() : located.files.slice(located.files.indexOf(located.file));
    const needle = Buffer.from(JSON.stringify(eventId), 'utf-8');
    const acc = new Map<string, Accumulator>();
    const tally = newTally(true);
    for (const file of files) {
      const bytes = this.readDayFile(file);
      if (bytes === undefined) {
        continue;
      }
      let from = 0;
      for (let hit = bytes.indexOf(needle, from); hit !== -1; hit = bytes.indexOf(needle, from)) {
        const lineStart = bytes.lastIndexOf(10, hit) + 1;
        const lineEnd = bytes.indexOf(10, hit);
        const line = bytes.toString('utf-8', lineStart, lineEnd === -1 ? bytes.length : lineEnd);
        const body = EVENT_ID_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
        // The id as the `eventId` key of the record, not as a value further on (a payload, a causedBy): compare the decoded key
        if (body !== undefined && unescapeJson(body) === eventId) {
          const record = parseRecordLine(tally, file, line);
          if (record !== undefined) {
            this.applyRecord(acc, record);
          }
        }
        from = lineEnd === -1 ? bytes.length : lineEnd + 1;
      }
    }
    this.commit(tally);
    return this.toEntries(acc)[0];
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
    const warnings = this.malformedWarnings();
    return { entries: all.slice(offset, offset + limit), total: all.length, limit, offset, ...(warnings.length > 0 && { warnings }) };
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

  /** How many events of each name were pushed in the `windowMs` before `nowMs`. Same cost and line matching as {@link countTriggers}. */
  countTriggersByEvent(nowMs: number, windowMs: number): Map<string, number> {
    const counts = new Map<string, number>();
    this.forEachRecord('trigger', nowMs, windowMs, (ts, line) => {
      const body = EVENT_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
      if (ts >= nowMs - windowMs && body !== undefined) {
        const event = unescapeJson(body);
        counts.set(event, (counts.get(event) ?? 0) + 1);
      }
    });
    return counts;
  }

  /**
   * Per event name pushed in the `windowMs` before `nowMs`: how many pushes, how many of them in the last `recentMs`, and when
   * the last one was. One pass, same cost and line matching as {@link countTriggers}: what the event catalog shows next to each event.
   */
  eventActivity(nowMs: number, windowMs: number, recentMs: number): Map<string, EventActivity> {
    const activity = new Map<string, EventActivity>();
    this.forEachRecord('trigger', nowMs, windowMs, (ts, line) => {
      const body = EVENT_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
      if (ts < nowMs - windowMs || body === undefined) {
        return;
      }
      const event = unescapeJson(body);
      const entry = activity.get(event) ?? { count: 0, recentCount: 0, lastSeenMs: 0 };
      entry.count++;
      if (ts >= nowMs - recentMs) {
        entry.recentCount++;
      }
      entry.lastSeenMs = Math.max(entry.lastSeenMs, ts);
      activity.set(event, entry);
    });
    return activity;
  }

  /** How the dispatches of each subscriber ended in the `windowMs` before `nowMs` (see {@link bucketOutcomes} for the statuses). */
  countOutcomesBySubscriber(nowMs: number, windowMs: number): Map<string, OutcomeCounts> {
    const counts = new Map<string, OutcomeCounts>();
    this.forEachRecord('outcome', nowMs, windowMs, (ts, line) => {
      const status = OUTCOME_STATUS.exec(line)?.[1] as keyof OutcomeCounts | undefined;
      const body = SUBSCRIBER_KEY.exec(line.slice(0, KEY_SEARCH_CHARS))?.[1];
      if (ts < nowMs - windowMs || status === undefined || body === undefined) {
        return;
      }
      const subscriberId = unescapeJson(body);
      const entry = counts.get(subscriberId) ?? { success: 0, failed: 0, dlq: 0 };
      entry[status]++;
      counts.set(subscriberId, entry);
    });
    return counts;
  }

  /** Calls `visit` with the time of every trigger record in the `lookbackMs` before `nowMs` (and none after it). */
  private forEachTrigger(nowMs: number, lookbackMs: number, visit: (ts: number) => void): void {
    this.forEachRecord('trigger', nowMs, lookbackMs, (ts) => visit(ts));
  }

  /** Calls `visit` with the time and the raw line of every record of that type in the `lookbackMs` before `nowMs`. */
  private forEachRecord(type: 'trigger' | 'outcome' | 'filtered', nowMs: number, lookbackMs: number, visit: (ts: number, line: string) => void): void {
    const oldestDay = new Date(nowMs - lookbackMs).toISOString().slice(0, 10);
    const tally = newTally(false);
    for (const file of this.listFiles()) {
      if (file.slice(0, 10) < oldestDay) {
        continue;
      }
      const onLine = (line: string): void => {
        const head = line.slice(0, LINE_HEAD_CHARS);
        const tsMatch = TS_KEY.exec(head);
        const typeMatch = RECORD_TYPE.exec(head);
        if (!tsMatch || typeMatch?.[1] !== type) {
          return;
        }
        const ts = Date.parse(tsMatch[1]!);
        if (Number.isNaN(ts) || ts > nowMs) {
          return;
        }
        // The head looks right, but a torn line (cut short, or glued to the next record) must not be counted: read() skips it, and both must agree
        if (!isIntactRecordLine(line)) {
          noteMalformed(tally, file, line);
          return;
        }
        visit(ts, line);
      };
      // In chunks, line by line: a week of history is hundreds of MB and the lines are not kept
      try {
        const { tail } = forEachLine(join(this.historyDir, file), 0, onLine);
        if (tail !== undefined) {
          onLine(tail);
        }
      } catch (err) {
        // Deleted by the history retention since the directory was listed: see readDayFile
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
    }
    this.commit(tally);
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

  /**
   * The bytes of a day file, or undefined when the file is gone: the history retention (run by the daemon, another process)
   * deletes whole days between the moment a reader lists the directory and the moment it opens a file, and a day deleted
   * by the retention is a day that is no longer in the history, not an error.
   */
  private readDayFile(file: string): Buffer | undefined {
    try {
      return readFileSync(join(this.historyDir, file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fileCache.delete(file);
        return undefined;
      }
      throw err;
    }
  }

  private readFileRecords(file: string): Record<string, unknown>[] {
    const filePath = join(this.historyDir, file);
    let mtimeMs: number;
    let size: number;
    try {
      // Rounded: utimes/stat round-trips can shift sub-millisecond precision on some
      // filesystems even with no real content change, which would defeat the cache.
      const stat = statSync(filePath);
      mtimeMs = Math.round(stat.mtimeMs);
      // The size is part of the key: an append inside the same timestamp tick (coarse clocks) keeps the mtime, never the size. A wait that is woken re-reads right after the append.
      size = stat.size;
    } catch (err) {
      // Deleted by the history retention since the directory was listed: see readDayFile
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fileCache.delete(file);
        return [];
      }
      throw err;
    }
    const cached = this.fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      this.setMalformed(file, cached.malformed);
      return cached.records;
    }

    const bytes = this.readDayFile(file);
    if (bytes === undefined) {
      return [];
    }
    const content = bytes.toString('utf-8');
    const records: Record<string, unknown>[] = [];
    const tally = newTally(false);
    for (const line of content.split('\n')) {
      const record = parseRecordLine(tally, file, line);
      if (record !== undefined) {
        records.push(record);
      }
    }
    const malformed = tally.files.get(file);
    this.fileCache.set(file, { mtimeMs, size, records, ...(malformed !== undefined && { malformed }) });
    this.setMalformed(file, malformed);
    return records;
  }

  // A full scan of a file knows everything about it: a file that is clean now (repaired by hand) stops being reported
  private setMalformed(file: string, malformed: MalformedHistoryFile | undefined): void {
    if (malformed === undefined) {
      this.malformedByFile.delete(file);
    } else {
      this.malformedByFile.set(file, malformed);
    }
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
      entry.projectId = record['projectId'] as string | undefined;
      entry.matchedCount = record['matchedCount'] as number;
      entry.totalCount = record['totalCount'] as number;
      entry.payload = record['payload'];
      entry.replayOf = record['replayOf'] as string | undefined;
      entry.cwd = record['cwd'] as string | undefined;
      entry.direction = record['direction'] as string[] | undefined;
      const causedBy = record['causedBy'];
      if (typeof causedBy === 'object' && causedBy !== null && typeof (causedBy as CausedBy).eventId === 'string' && typeof (causedBy as CausedBy).subscriberId === 'string') {
        entry.causedBy = { eventId: (causedBy as CausedBy).eventId, subscriberId: (causedBy as CausedBy).subscriberId };
      }
      return;
    }
    if (type === 'outcome') {
      entry.ts = entry.ts ?? ts;
      entry.event = entry.event ?? (record['event'] as string);
      entry.subscribers.push({
        subscriberId: record['subscriberId'] as string,
        status: record['status'] as HistorySubscriberOutcome['status'],
        target: record['target'] as string | undefined,
        ...projectRefsOfRecord(record),
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
        ...projectRefsOfRecord(record),
      });
    }
  }

  private matches(entry: HistoryEntry, filter: HistoryFilter): boolean {
    if (filter.event && entry.event !== filter.event) {
      return false;
    }
    // The project of the push, or of any subscriber the event was dispatched to (a descendant reached with to-children, a retry with no trigger)
    if (filter.projectId && entry.projectId !== filter.projectId && !entry.subscribers.some((s) => s.projectId === filter.projectId)) {
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

/**
 * Whether a line that starts like a record is one complete record, without parsing it in the common case: a complete line ends with a brace and holds no second
 * record start; anything else is parsed to know. The aggregates read tens of MB, which is why the common case is not parsed.
 */
function isIntactRecordLine(line: string): boolean {
  const trimmed = line.trimEnd();
  if (trimmed.endsWith('}') && trimmed.indexOf(RECORD_START, 1) === -1) {
    return true;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function toTriggerRecord(record: Record<string, unknown>): TriggerRecord {
  const str = (key: string): string | undefined => (typeof record[key] === 'string' ? (record[key] as string) : undefined);
  const causedBy = record['causedBy'] as Partial<CausedBy> | null | undefined;
  return {
    ts: str('ts') ?? new Date(0).toISOString(),
    eventId: record['eventId'] as string,
    event: str('event') ?? '(unknown)',
    ...(record['payload'] !== undefined && { payload: record['payload'] }),
    ...(str('project') !== undefined && { project: str('project') }),
    ...(str('projectId') !== undefined && { projectId: str('projectId') }),
    ...(str('cwd') !== undefined && { cwd: str('cwd') }),
    ...(str('replayOf') !== undefined && { replayOf: str('replayOf') }),
    ...(Array.isArray(record['direction']) && { direction: record['direction'] as string[] }),
    ...(typeof causedBy?.eventId === 'string' && typeof causedBy.subscriberId === 'string' && { causedBy: { eventId: causedBy.eventId, subscriberId: causedBy.subscriberId } }),
  };
}

function projectRefsOfRecord(record: Record<string, unknown>): { projectId?: string; emitterProjectId?: string } {
  const projectId = record['projectId'];
  const emitterProjectId = record['emitterProjectId'];
  return { ...(typeof projectId === 'string' && { projectId }), ...(typeof emitterProjectId === 'string' && { emitterProjectId }) };
}
