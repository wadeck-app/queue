import { existsSync, mkdirSync, openSync, closeSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventMeta } from '../types.js';
import { FileLock } from './FileLock.js';

export interface WalEntry {
  id: string;
  timestamp: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
  subscriberId: string;
  status: 'pending' | 'acked' | 'failed' | 'dlq';
  attempts: number;
  lastError?: string;
  ackedAt?: string;
}

const ACKED_RETENTION_MS = 24 * 3600_000;

export class Wal {
  private readonly filePath: string;
  // Serialises the read-modify-write of every writer process (the daemon, app-core's queue module)
  private readonly lock: FileLock;

  private readonly now: () => number;
  private readonly ackedRetentionMs: number;

  constructor(filePath: string, options: { now?: () => number; ackedRetentionMs?: number } = {}) {
    this.filePath = filePath;
    this.lock = new FileLock(`${filePath}.lock`);
    this.now = options.now ?? Date.now;
    this.ackedRetentionMs = options.ackedRetentionMs ?? ACKED_RETENTION_MS;
  }

  /**
   * Every write rewrites the whole file, so an ever-growing WAL made each write slower (2.5 MB, ~15 ms, after six weeks).
   * An acknowledged entry has nothing left to replay (`queue history` keeps the trace): only pending, failed and dlq
   * entries are state worth keeping.
   */
  private withoutOldAcked(entries: WalEntry[]): WalEntry[] {
    const limit = this.now() - this.ackedRetentionMs;
    return entries.filter(e => e.status !== 'acked' || Date.parse(e.ackedAt ?? e.timestamp) >= limit);
  }

  private ensureFile(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      const fd = openSync(this.filePath, 'a', 0o600);
      closeSync(fd);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // chmod is a no-op on Windows; acceptable
      }
    }
  }

  append(entry: WalEntry): void {
    this.ensureFile();
    this.lock.withLock((held) => {
      this.commitEntries(this.withoutOldAcked([...this.readAll(), entry]), held);
    });
  }

  readAll(): WalEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8');
    const entries: WalEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as WalEntry);
      } catch {
        process.stderr.write(`[queue] WAL: skipping malformed line: ${trimmed.slice(0, 80)}\n`);
      }
    }
    return entries;
  }

  updateEntry(id: string, updates: Partial<WalEntry>): void {
    this.lock.withLock((held) => {
      const updated = this.readAll().map(e => (e.id === id ? { ...e, ...updates } : e));
      this.commitEntries(this.withoutOldAcked(updated), held);
    });
  }

  private commitEntries(entries: WalEntry[], held: FileLock): void {
    this.commit(entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), held);
  }

  /** Replaces the file atomically (readers never see a half-written file). Must be called with the lock held. */
  private commit(content: string, held: FileLock): void {
    // One temp file per process: a shared name made concurrent writers rename each other's file away
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    held.assertHeld();
    renameSync(tmpPath, this.filePath);
  }

  pendingCount(): number {
    return this.readAll().filter(e => e.status === 'pending').length;
  }
}
