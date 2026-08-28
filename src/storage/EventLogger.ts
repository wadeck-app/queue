import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMeta } from '../types.js';

export interface DispatchRecord {
  subscriberId: string;
  status: 'acked' | 'failed' | 'filter-miss';
  durationMs: number;
  error?: string;
  filterMatch: boolean;
}

export interface EventLogEntry {
  id: string;
  timestamp: string;
  event: string;
  meta: EventMeta;
  mode: 'async' | 'sync';
  dispatches: DispatchRecord[];
}

export class EventLogger {
  private readonly logsDir: string;

  constructor(logsDir: string) {
    this.logsDir = logsDir;
  }

  private ensureDir(): void {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private currentDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  append(entry: EventLogEntry): void {
    this.ensureDir();
    const file = join(this.logsDir, `${this.currentDateStr()}.ndjson`);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  }

  readDay(date: string): EventLogEntry[] {
    const file = join(this.logsDir, `${date}.ndjson`);
    if (!existsSync(file)) return [];
    const content = readFileSync(file, 'utf-8');
    const entries: EventLogEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as EventLogEntry);
      } catch {
        // skip malformed
      }
    }
    return entries;
  }
}
