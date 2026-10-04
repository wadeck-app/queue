import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HistorySubscriberOutcome {
  subscriberId: string;
  status: 'success' | 'failed' | 'dlq' | 'filtered';
  /** Resolved command or URL for success/failed/dlq outcomes. */
  target?: string;
  /** The raw `when:` expression, for filtered outcomes. */
  filter?: string;
  path?: string;
  expected?: string;
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
}

export interface HistoryFilter {
  event?: string;
  subscriberId?: string;
  status?: 'success' | 'failed' | 'dlq' | 'filtered';
  sinceMs?: number;
}

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

interface Accumulator {
  ts?: string;
  eventId: string;
  event?: string;
  project?: string;
  totalCount?: number;
  matchedCount?: number;
  subscribers: HistorySubscriberOutcome[];
}

export class HistoryReader {
  constructor(private readonly historyDir: string) {}

  read(filter: HistoryFilter = {}): HistoryEntry[] {
    const acc = new Map<string, Accumulator>();

    for (const file of this.listFiles()) {
      const content = readFileSync(join(this.historyDir, file), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(trimmed);
        } catch (err) {
          throw new Error(`Malformed history record in ${file}: ${trimmed} (${(err as Error).message})`);
        }
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
    }));

    return entries
      .filter(e => this.matches(e, filter))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  private listFiles(): string[] {
    if (!existsSync(this.historyDir)) return [];
    return readdirSync(this.historyDir).filter(f => DATE_FILE.test(f)).sort();
  }

  private applyRecord(acc: Map<string, Accumulator>, record: Record<string, unknown>): void {
    const eventId = record['eventId'] as string | undefined;
    if (!eventId) return;
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
        path: record['path'] as string | undefined,
        expected: record['expected'] as string | undefined,
        actual: record['actual'] as string | undefined,
      });
    }
  }

  private matches(entry: HistoryEntry, filter: HistoryFilter): boolean {
    if (filter.event && entry.event !== filter.event) return false;
    if (filter.sinceMs !== undefined && Date.parse(entry.ts) < filter.sinceMs) return false;
    if (filter.subscriberId && !entry.subscribers.some(s => s.subscriberId === filter.subscriberId)) return false;
    if (filter.status && !entry.subscribers.some(s => s.status === filter.status)) return false;
    return true;
  }
}
