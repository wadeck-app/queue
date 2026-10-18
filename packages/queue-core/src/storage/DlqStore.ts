import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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
    renameSync(tmpPath, this.filePath);
  }

  append(entry: DlqEntry): void {
    this.ensureDir();
    this.lock.withLock((held) => {
      let entries = this.readAll();
      if (entries.length >= this.maxSize) {
        process.stderr.write(`[queue] DLQ limit reached (${this.maxSize}). Removing oldest entry.\n`);
        entries = entries.slice(1);
      }
      entries.push(entry);
      this.write(entries, held);
    });
  }

  readAll(): DlqEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    const entries: DlqEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
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
    this.ensureDir();
    return this.lock.withLock((held) => {
      const before = this.readAll();
      const after = before.filter(e => e.id !== id);
      this.write(after, held);
      return before.length - after.length;
    });
  }

  clear(): number {
    this.ensureDir();
    return this.lock.withLock((held) => {
      const count = this.readAll().length;
      this.write([], held);
      return count;
    });
  }
}
