import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventMeta } from '../types.js';

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

  constructor(filePath: string, maxSize = 1000) {
    this.filePath = filePath;
    this.maxSize = maxSize;
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private write(entries: DlqEntry[]): void {
    this.ensureDir();
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  append(entry: DlqEntry): void {
    let entries = this.readAll();
    if (entries.length >= this.maxSize) {
      process.stderr.write(`[queue] DLQ limit reached (${this.maxSize}). Removing oldest entry.\n`);
      entries = entries.slice(1);
    }
    entries.push(entry);
    this.write(entries);
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

  remove(id: string): void {
    const entries = this.readAll().filter(e => e.id !== id);
    this.write(entries);
  }

  clear(): number {
    const entries = this.readAll();
    this.write([]);
    return entries.length;
  }
}
