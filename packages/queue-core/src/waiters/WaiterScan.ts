import { join } from 'node:path';
import type { EventEnvelope } from '../types.js';
import { processIsAlive } from '../storage/FileLock.js';
import { waitersDir } from './WaiterHistory.js';
import { WAITER_LIMITS, parseWaiterRecord, type ParsedWaiterRecord, type WaiterRecord } from './WaiterRecord.js';
import { WAITER_TTL_MS, defaultWaiterFs, errorCode, errorText, isWaiterLive, type WaiterFs } from './WaiterLiveness.js';
import { waiterCountsFor } from './WaiterMatch.js';
import { waiterNameOfFile } from './waiterName.js';

/** More files than this in the folder: the rest are not looked at (and it is said). A push must not read thousands of files. */
export const MAX_WAITER_FILES = 200;
/** The scan of a push stops after this long and answers with what it has. */
export const WAITER_SCAN_TIME_BOX_MS = 100;

/** A live waiter: its record and the time of its last heartbeat (the modification time of its file). */
export type LiveWaiter = WaiterRecord & { lastSeenMs: number };

export interface WaiterScan {
  waiters: LiveWaiter[];
  /** Files that cannot be used, with their path and why, and the bounds that were hit. The caller says each once. */
  problems: string[];
  /** True when a bound (file cap, time box) cut the scan: the list may be short. */
  partial: boolean;
}

/**
 * What was parsed from the files, keyed on what identifies a version of a file: `(name, inode, creation time, size)`. A heartbeat changes none of them (it only touches the
 * modification time, which is read fresh for the liveness). A replaced file is a new file. Entries of files that are gone are dropped at each scan.
 */
export class WaiterScanCache {
  private entries = new Map<string, ParsedWaiterRecord>();

  get size(): number {
    return this.entries.size;
  }

  /** @internal */
  get(key: string): ParsedWaiterRecord | undefined {
    return this.entries.get(key);
  }

  /** @internal Replaces the content by the entries seen in the scan that just ended. */
  replace(seen: Map<string, ParsedWaiterRecord>): void {
    this.entries = seen;
  }
}

export interface WaiterScanOptions {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  /** Only the waiters that count for this event (the daemon's counting rule, see {@link waiterCountsFor}). Absent: every live waiter. */
  matching?: EventEnvelope;
  /** Kept between scans by a caller that scans often (the daemon, at each push). Default: none. */
  cache?: WaiterScanCache;
  fs?: Partial<WaiterFs>;
  /** Milliseconds, monotonic; default `performance.now`. For the time box. */
  clock?: () => number;
  maxFiles?: number;
  timeBoxMs?: number;
  ttlMs?: number;
}

/**
 * The live waiters of a config directory, read from their files. Never throws and never deletes (the sweep is the registry's): what is wrong is in `problems`.
 * Cost control for the push path: `readdir` + `stat`, a heartbeat older than the TTL is skipped WITHOUT reading the file, the parse is cached, at most
 * {@link MAX_WAITER_FILES} files are looked at, and the scan stops after {@link WAITER_SCAN_TIME_BOX_MS} ms (`partial`).
 */
export function listLiveWaiters(configDir: string, options: WaiterScanOptions = {}): WaiterScan {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
  const fs = { ...defaultWaiterFs, ...options.fs };
  const clock = options.clock ?? (() => performance.now());
  const maxFiles = options.maxFiles ?? MAX_WAITER_FILES;
  const timeBoxMs = options.timeBoxMs ?? WAITER_SCAN_TIME_BOX_MS;
  const ttlMs = options.ttlMs ?? WAITER_TTL_MS;
  const dir = waitersDir(configDir);
  const result: WaiterScan = { waiters: [], problems: [], partial: false };

  let names: string[];
  try {
    names = fs.readdir(dir).filter((name) => waiterNameOfFile(name) !== undefined).sort();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      result.problems.push(`could not list ${dir}: ${errorText(error)}; the waiters were not counted. Fix: check that the folder is readable by this user.`);
    }
    return result;
  }
  const total = names.length;
  if (total > maxFiles) {
    names = names.slice(0, maxFiles);
    result.partial = true;
    result.problems.push(`${dir} holds ${total} waiter files; only the first ${maxFiles} were looked at, so the count of waiters may be short. Fix: delete the files of waits that are over from that folder.`);
  }

  const started = clock();
  const seen = new Map<string, ParsedWaiterRecord>();
  let looked = 0;
  for (const fileName of names) {
    if (clock() - started > timeBoxMs) {
      result.partial = true;
      result.problems.push(`the scan of ${dir} stopped after ${timeBoxMs} ms with ${looked} of ${names.length} files looked at, so the count of waiters may be short.`);
      break;
    }
    looked++;
    const path = join(dir, fileName);
    try {
      const stat = fs.stat(path);
      if (now() - stat.mtimeMs > ttlMs) {
        continue;
      }
      let parsed: ParsedWaiterRecord;
      if (stat.size > WAITER_LIMITS.maxFileBytes) {
        parsed = { ok: false, kind: 'oversize', problem: `${fileName} is over ${WAITER_LIMITS.maxFileBytes} bytes: it was not read` };
      } else {
        const key = `${fileName}\0${stat.ino}\0${stat.birthtimeMs}\0${stat.size}`;
        parsed = options.cache?.get(key) ?? parseWaiterRecord(fs.readFile(path), fileName);
        seen.set(key, parsed);
      }
      if (!parsed.ok) {
        result.problems.push(`${path}: ${parsed.problem}; it is ignored.`);
        continue;
      }
      if (!isWaiterLive({ pid: parsed.record.pid, mtimeMs: stat.mtimeMs }, now(), isAlive, ttlMs)) {
        continue;
      }
      if (options.matching !== undefined && !waiterCountsFor(parsed.record, options.matching)) {
        continue;
      }
      result.waiters.push({ ...parsed.record, lastSeenMs: stat.mtimeMs });
    } catch (error) {
      // Gone between the listing and now: nothing to count
      if (errorCode(error) !== 'ENOENT') {
        result.problems.push(`${path}: could not be read (${errorText(error)}); it is ignored.`);
      }
    }
  }
  options.cache?.replace(seen);
  return result;
}
