import { existsSync, mkdirSync } from 'node:fs';
import { appendLine } from './AppendLine.js';
import { getErrorMessage } from '../errors.js';
import { join } from 'node:path';
import { pruneLogDir, describeRetention, type PruneOptions, type PruneReport } from './LogRetention.js';

export interface DispatchLogEntry {
  event: string;
  subscriberId: string;
  status: 'success' | 'failed' | 'dlq';
  target?: string;
  durationMs?: number;
  error?: string;
  attempts?: number;
  /** Tail of the subscriber's stdout, see OutputCapture.forLog for the retention policy. */
  stdout?: string;
  /** Tail of the subscriber's stderr, see OutputCapture.forLog for the retention policy. */
  stderr?: string;
  /** Exit code of a cli command that ran to its end. */
  exitCode?: number;
  /** Last LOG_TAIL_CHARS characters of a cli command's stdout, control characters stripped; absent when empty. See OutputCapture.dispatchFields. */
  stdoutTail?: string;
  /** Same for stderr. */
  stderrTail?: string;
  /** What an action reported on success (e.g. the event it emitted); empty for cli and http. */
  detail?: string;
}

export interface FilterMissLogEntry {
  event: string;
  subscriberId: string;
  /** The raw `when:` expression from subscribers.yml. */
  filter: string;
  reason: string;
  /** The path that was looked up, when the filter has one. */
  path?: string;
  expected?: string;
  /** The value actually found at `path`, absent when nothing was found. */
  actual?: string;
}

export interface DiagnosticLogEntry {
  /** Emitting component, e.g. 'AsyncDispatcher' or 'QueueDaemon.push'. */
  source: string;
  message: string;
  /** Severity, written as is in the record (retention reports use it); absent for a plain diagnostic. */
  level?: 'info' | 'warn';
}

/**
 * Sink for everything the daemon must make observable.
 *
 * The daemon is spawned with stdio:'ignore' (see QueueIndex.spawnDaemon), so any
 * process.stderr.write inside the daemon is lost. Daemon-internal diagnostics must go through
 * this interface so they land in <configDir>/logs/<date>.ndjson and show up in `queue logs`.
 */
export interface QueueLogWriter {
  logDispatch(entry: DispatchLogEntry): void;
  logFilterMiss(entry: FilterMissLogEntry): void;
  logDiagnostic(entry: DiagnosticLogEntry): void;
}

export class EventLogger implements QueueLogWriter {
  private readonly logsDir: string;

  private readonly prune: (dir: string, options: PruneOptions) => PruneReport;

  /** @param prune Log retention, replaceable for tests. */
  constructor(logsDir: string, prune: (dir: string, options: PruneOptions) => PruneReport = pruneLogDir) {
    this.logsDir = logsDir;
    this.prune = prune;
  }

  private ensureDir(): void {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
  }

  private currentDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // Records that could not be written since the last one that could: the next record says so in the log itself
  private lost: { count: number; firstCause: string } | undefined;
  private readonly reportedCauses = new Set<string>();

  /**
   * Never throws: a log that cannot be written (the day file is locked by an antivirus, the disk is full) must not take the dispatch, the push or the retry down with it.
   * The loss is said once per cause on stderr, and the first record that can be written afterwards says in the log how many were lost and why.
   */
  private write(type: 'dispatch' | 'filter-miss' | 'diagnostic', entry: object): void {
    try {
      this.writeRecord(type, entry);
      this.reportLoss();
    } catch (err) {
      this.noteLoss(err);
    }
  }

  private noteLoss(err: unknown): void {
    const cause = getErrorMessage(err);
    this.lost = { count: (this.lost?.count ?? 0) + 1, firstCause: this.lost?.firstCause ?? cause };
    if (!this.reportedCauses.has(cause)) {
      this.reportedCauses.add(cause);
      try {
        process.stderr.write(`[queue] EventLogger: could not write to ${this.logsDir}: ${cause}. Records are lost until it can be written; the first record written afterwards says how many. Check that nothing locks the folder and that the disk has room\n`);
      } catch {
        // nowhere left to say it
      }
    }
  }

  private reportLoss(): void {
    if (this.lost === undefined) {
      return;
    }
    const { count, firstCause } = this.lost;
    this.append(join(this.logsDir, `${this.currentDateStr()}.ndjson`), 'diagnostic', {
      source: 'EventLogger',
      level: 'warn',
      message: `${count} log record(s) could not be written to ${this.logsDir} and are missing from this log (first cause: ${firstCause}). Check that nothing locks the folder (antivirus, indexer) and that the disk has room`,
    });
    this.lost = undefined;
  }

  private writeRecord(type: 'dispatch' | 'filter-miss' | 'diagnostic', entry: object): void {
    this.ensureDir();
    const day = this.currentDateStr();
    const file = join(this.logsDir, `${day}.ndjson`);
    // A new day's file is the one moment the retention runs (not on every write)
    const isNewDay = !existsSync(file);
    const retentionLines = isNewDay ? this.runRetention(day) : [];
    this.append(file, type, entry);
    for (const line of retentionLines) {
      this.append(file, line.type, { source: 'LogRetention', message: line.message, level: line.level });
    }
  }

  private append(file: string, type: string, entry: object): void {
    appendLine(file, JSON.stringify({ ts: new Date().toISOString(), type, ...entry }) + '\n');
  }

  /** Never throws: a retention problem must not make a log write fail. Returns the lines to log once the day file exists. */
  private runRetention(day: string): { type: 'diagnostic'; level: 'info' | 'warn'; message: string }[] {
    const lines: { type: 'diagnostic'; level: 'info' | 'warn'; message: string }[] = [];
    try {
      const report = this.prune(this.logsDir, { now: new Date(), keepDay: day });
      for (const line of describeRetention('Log', report)) {
        lines.push({ type: 'diagnostic', ...line });
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      lines.push({ type: 'diagnostic', level: 'warn', message: `Log retention failed: ${msg}. Check that ${this.logsDir} is readable; old logs are not pruned until the next new day.` });
    }
    return lines;
  }

  logDispatch(entry: DispatchLogEntry): void {
    this.write('dispatch', entry);
  }

  logFilterMiss(entry: FilterMissLogEntry): void {
    this.write('filter-miss', entry);
  }

  logDiagnostic(entry: DiagnosticLogEntry): void {
    this.write('diagnostic', entry);
  }
}
