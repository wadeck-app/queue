import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneLogDir, type PruneOptions, type PruneReport } from './LogRetention.js';

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

  private write(type: 'dispatch' | 'filter-miss' | 'diagnostic', entry: object): void {
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
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), type, ...entry }) + '\n', 'utf-8');
  }

  /** Never throws: a retention problem must not make a log write fail. Returns the lines to log once the day file exists. */
  private runRetention(day: string): { type: 'diagnostic'; level: 'info' | 'warn'; message: string }[] {
    const lines: { type: 'diagnostic'; level: 'info' | 'warn'; message: string }[] = [];
    try {
      const report = this.prune(this.logsDir, { now: new Date(), keepDay: day });
      if (report.deleted.length > 0) {
        const freed = report.deleted.reduce((sum, d) => sum + d.bytes, 0);
        const what = report.deleted.map(d => `${d.file} (${d.reason})`).join(', ');
        lines.push({ type: 'diagnostic', level: 'info', message: `Log retention deleted ${report.deleted.length} file(s), ${freed} bytes freed: ${what}` });
      }
      const problems = report.failures.map(f => `${f.file}: ${f.error}. ${f.fix}`);
      if (report.warning) problems.unshift(report.warning);
      if (problems.length > 0) {
        lines.push({ type: 'diagnostic', level: 'warn', message: `Log retention: ${problems.join(' | ')}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
