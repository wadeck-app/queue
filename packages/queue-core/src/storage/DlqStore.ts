import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renameReplacing } from './AtomicRename.js';
import { dirname } from 'node:path';
import type { EventMeta } from '../types.js';
import { FileLock } from './FileLock.js';
import { quarantineCorruptLines, removeStaleTempFiles, stderrDiagnosticSink, type StorageDiagnosticSink } from './StorageDiagnostics.js';
import type { DlqAddedInfo } from '../dlqEvents.js';

export interface DlqEntry {
  id: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
  subscriberId: string;
  attempts: number;
  lastError: string;
  movedAt: string;
  /**
   * Whether the queue.dlq.added event of this row still has to be emitted. `pending`: the emit did not succeed (an invalid subscribers.yml, a refused push), the daemon
   * tries again at its start and after the next successful push; `skipped`: deliberately not emitted (the hop cap), the diagnostic names the entry. Absent: emitted.
   */
  announce?: 'pending' | 'skipped';
  /** The facts the event is built from later (the reason, exit code and target of the failure): present while `announce` is. */
  announceInfo?: DlqAddedInfo;
}

export interface DlqAppendResult {
  /** False when an entry with the same id was already there and was replaced. */
  inserted: boolean;
  /** The oldest entry, dropped because the cap was reached. */
  evicted?: DlqEntry;
}

export class DlqStore {
  private readonly filePath: string;
  private readonly maxSize: number;
  // Serialises the read-modify-write of every writer process (the daemon, app-core's queue module)
  private readonly lock: FileLock;
  private readonly diagnostics: StorageDiagnosticSink;
  private tempFilesCleaned = false;

  /** @param options.onDiagnostic Where unreadable lines and the "limit reached" notice are reported (the daemon passes EventLogger.logDiagnostic); default: stderr. */
  constructor(filePath: string, maxSize = 1000, options: { onDiagnostic?: StorageDiagnosticSink } = {}) {
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.diagnostics = options.onDiagnostic ?? stderrDiagnosticSink;
    this.lock = new FileLock(`${filePath}.lock`);
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Replaces the file atomically (readers never see a half-written file). Must be called with the lock held. */
  private write(entries: DlqEntry[], held: FileLock): void {
    this.ensureDir();
    // The leftovers of writers that died between the write and the rename: once per instance, before the first write
    if (!this.tempFilesCleaned) {
      this.tempFilesCleaned = true;
      removeStaleTempFiles(this.filePath);
    }
    // One temp file per process: a shared name made concurrent writers rename each other's file away
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    // 0600 like the WAL: the rows carry push payloads
    writeFileSync(tmpPath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), { encoding: 'utf-8', mode: 0o600 });
    held.assertHeld();
    renameReplacing(tmpPath, this.filePath);
  }

  /**
   * Idempotent on `entry.id`: an entry with that id is replaced (and moves to the end, as the newest), so a retry of the same move after a crash
   * never duplicates a row; `inserted` is false then. When a new row exceeds the cap, the oldest one is dropped and returned as `evicted`
   * (a replacement never evicts: the size does not grow).
   */
  append(entry: DlqEntry): DlqAppendResult {
    this.ensureDir();
    return this.lock.withLock((held) => {
      let entries = this.readForRewrite();
      const existing = entries.some((e) => e.id === entry.id);
      let evicted: DlqEntry | undefined;
      if (existing) {
        entries = entries.filter((e) => e.id !== entry.id);
      } else if (entries.length >= this.maxSize) {
        evicted = entries[0];
        this.diagnostics({
          source: 'DlqStore',
          level: 'warn',
          message:
            `DLQ limit reached (${this.maxSize}): the oldest entry ${evicted!.id} (event ${evicted!.event}, subscriber ${evicted!.subscriberId}, moved at ${evicted!.movedAt}) was removed to make room and can no longer be replayed. ` +
            `Replay or clear the dead-letter queue (queue dlq) before it drops more.`,
        });
        entries = entries.slice(1);
      }
      entries.push(entry);
      this.write(entries, held);
      return { inserted: !existing, ...(evicted !== undefined && { evicted }) };
    });
  }

  /** The row with this id, or undefined (a plain read, like {@link has}). */
  get(id: string): DlqEntry | undefined {
    return this.readAll().find((entry) => entry.id === id);
  }

  /** Sets the mark of a row (`undefined` clears it together with its facts) in one write under the lock. False when the row is not there: nothing is written. */
  setAnnounce(id: string, announce: 'pending' | 'skipped' | undefined): boolean {
    this.ensureDir();
    return this.lock.withLock((held) => {
      const entries = this.readForRewrite();
      const index = entries.findIndex((e) => e.id === id);
      if (index === -1) {
        return false;
      }
      const { announce: _previous, announceInfo, ...rest } = entries[index] as DlqEntry;
      entries[index] = announce === undefined ? rest : { ...rest, announce, ...(announceInfo !== undefined && { announceInfo }) };
      this.write(entries, held);
      return true;
    });
  }

  /**
   * Whether a row with this id is in the file now. A plain read (the file is replaced atomically, so it is never half-written): another writer may insert
   * the row right after, which `append` then reports as `inserted: false`.
   */
  has(id: string): boolean {
    return this.readAll().some((entry) => entry.id === id);
  }

  readAll(): DlqEntry[] {
    const { entries, corrupt } = this.parse();
    for (const line of corrupt) {
      process.stderr.write(`[queue] DLQ: skipping malformed line: ${line.slice(0, 80)}\n`);
    }
    return entries;
  }

  private parse(): { entries: DlqEntry[]; corrupt: string[] } {
    const entries: DlqEntry[] = [];
    const corrupt: string[] = [];
    if (!existsSync(this.filePath)) {
      return { entries, corrupt };
    }
    for (const line of readFileSync(this.filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed) as DlqEntry);
      } catch {
        corrupt.push(trimmed);
      }
    }
    return { entries, corrupt };
  }

  /** The rows to rewrite the file from, under the lock: the unreadable lines the rewrite is about to drop are kept aside and reported first. */
  private readForRewrite(): DlqEntry[] {
    const { entries, corrupt } = this.parse();
    quarantineCorruptLines(this.filePath, corrupt, 'DlqStore', this.diagnostics);
    return entries;
  }

  /** Returns how many entries were removed (0 for an unknown id). */
  remove(id: string): number {
    return this.removeEntries(id).length;
  }

  /** Removes the entries with these ids and returns them (read under the same lock as the removal); unknown ids are ignored. */
  removeEntries(ids: string | readonly string[]): DlqEntry[] {
    const wanted = new Set(typeof ids === 'string' ? [ids] : ids);
    this.ensureDir();
    return this.lock.withLock((held) => {
      const before = this.readForRewrite();
      const removed = before.filter((e) => wanted.has(e.id));
      this.write(before.filter((e) => !wanted.has(e.id)), held);
      return removed;
    });
  }

  /** Returns how many entries were removed. */
  clear(): number {
    return this.clearEntries().length;
  }

  /** Removes every entry and returns them (read under the same lock as the removal). */
  clearEntries(): DlqEntry[] {
    this.ensureDir();
    return this.lock.withLock((held) => {
      const removed = this.readForRewrite();
      this.write([], held);
      return removed;
    });
  }
}
