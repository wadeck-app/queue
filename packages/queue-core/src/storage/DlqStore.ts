import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renameReplacing } from './AtomicRename.js';
import { dirname } from 'node:path';
import type { EventMeta } from '../types.js';
import { FileLock } from './FileLock.js';

export interface DlqEntry {
  id: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
  subscriberId: string;
  attempts: number;
  lastError: string;
  movedAt: string;
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

  constructor(filePath: string, maxSize = 1000) {
    this.filePath = filePath;
    this.maxSize = maxSize;
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
    // One temp file per process: a shared name made concurrent writers rename each other's file away
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf-8');
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
      let entries = this.readAll();
      const existing = entries.some((e) => e.id === entry.id);
      let evicted: DlqEntry | undefined;
      if (existing) {
        entries = entries.filter((e) => e.id !== entry.id);
      } else if (entries.length >= this.maxSize) {
        process.stderr.write(`[queue] DLQ limit reached (${this.maxSize}). Removing oldest entry.\n`);
        evicted = entries[0];
        entries = entries.slice(1);
      }
      entries.push(entry);
      this.write(entries, held);
      return { inserted: !existing, ...(evicted !== undefined && { evicted }) };
    });
  }

  readAll(): DlqEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const content = readFileSync(this.filePath, 'utf-8');
    const entries: DlqEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed) as DlqEntry);
      } catch {
        process.stderr.write(`[queue] DLQ: skipping malformed line\n`);
      }
    }
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
      const before = this.readAll();
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
      const removed = this.readAll();
      this.write([], held);
      return removed;
    });
  }
}
