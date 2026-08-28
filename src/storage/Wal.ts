import { existsSync, mkdirSync, openSync, closeSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventMeta } from '../types.js';

export interface WalEntry {
  id: string;
  timestamp: string;
  event: string;
  payload: unknown;
  meta: EventMeta;
  subscriberId: string;
  status: 'pending' | 'acked' | 'failed';
  attempts: number;
  lastError?: string;
  ackedAt?: string;
}

export class Wal {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
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
    const tmpPath = `${this.filePath}.tmp`;
    const existing = existsSync(this.filePath) ? readFileSync(this.filePath, 'utf-8') : '';
    const line = JSON.stringify(entry) + '\n';
    writeFileSync(tmpPath, existing + line, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, this.filePath);
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
    const entries = this.readAll();
    const updated = entries.map(e => (e.id === id ? { ...e, ...updates } : e));
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, updated.map(e => JSON.stringify(e)).join('\n') + (updated.length > 0 ? '\n' : ''), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }

  pendingCount(): number {
    return this.readAll().filter(e => e.status === 'pending').length;
  }
}
