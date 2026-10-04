import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TriggerHistoryEntry {
  eventId: string;
  event: string;
  project?: string;
  matchedCount: number;
  totalCount: number;
}

export interface OutcomeHistoryEntry {
  eventId: string;
  event: string;
  subscriberId: string;
  status: 'success' | 'failed' | 'dlq';
  /** Resolved command or URL, so a failing/dlq'd outcome in `queue history` says what actually ran. */
  target?: string;
}

export interface FilteredHistoryEntry {
  eventId: string;
  event: string;
  subscriberId: string;
  /** The raw `when:` expression from subscribers.yml, so a filtered entry says why it was skipped. */
  filter: string;
  path?: string;
  expected?: string;
  actual?: string;
}

/**
 * Sink for the terse "what was triggered, who listened" journal, kept separate from EventLogger's
 * verbose logs/ ndjson (which carries captured stdout/stderr and is gated to avoid noise on clean
 * successes). History entries are always written, regardless of noise, so `queue history` never
 * misses a trigger or an outcome.
 */
export interface HistoryWriter {
  logTrigger(entry: TriggerHistoryEntry): void;
  logOutcome(entry: OutcomeHistoryEntry): void;
  logFiltered(entry: FilteredHistoryEntry): void;
}

export class HistoryLog implements HistoryWriter {
  private readonly historyDir: string;

  constructor(historyDir: string) {
    this.historyDir = historyDir;
  }

  private ensureDir(): void {
    if (!existsSync(this.historyDir)) {
      mkdirSync(this.historyDir, { recursive: true });
    }
  }

  private currentDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private write(type: 'trigger' | 'outcome' | 'filtered', entry: object): void {
    this.ensureDir();
    const file = join(this.historyDir, `${this.currentDateStr()}.ndjson`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), type, ...entry }) + '\n', 'utf-8');
  }

  logTrigger(entry: TriggerHistoryEntry): void {
    this.write('trigger', entry);
  }

  logOutcome(entry: OutcomeHistoryEntry): void {
    this.write('outcome', entry);
  }

  logFiltered(entry: FilteredHistoryEntry): void {
    this.write('filtered', entry);
  }
}
