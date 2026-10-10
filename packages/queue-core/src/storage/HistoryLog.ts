import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

export interface TriggerHistoryEntry {
  eventId: string;
  event: string;
  project?: string;
  matchedCount: number;
  totalCount: number;
  /** Original push payload, so `queue replay <eventId>` can resubmit it unchanged. */
  payload?: unknown;
  /** Set when this trigger was created by `queue replay`, pointing at the eventId it replays. */
  replayOf?: string;
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
  /** Value actually found at the filter's path, when one was found. path/expected are already in `filter`, so they aren't duplicated here. */
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
  private readonly retentionDays: number;

  // Trigger records carry the push payload (for `queue replay`), which can contain secrets
  // (see threat-model.md) -- unlike WAL/DLQ, nothing else ever clears a history entry, so a
  // day-based retention window is the only thing bounding how long that payload is kept.
  constructor(historyDir: string, retentionDays = 30) {
    this.historyDir = historyDir;
    this.retentionDays = retentionDays;
  }

  private ensureDir(): void {
    if (!existsSync(this.historyDir)) {
      mkdirSync(this.historyDir, { recursive: true });
    }
  }

  private currentDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private pruneOldFiles(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const file of readdirSync(this.historyDir)) {
      const match = DATE_FILE.exec(file);
      if (match && match[1]! < cutoffStr) {
        unlinkSync(join(this.historyDir, file));
      }
    }
  }

  private write(type: 'trigger' | 'outcome' | 'filtered', entry: object): void {
    this.ensureDir();
    this.pruneOldFiles();
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
