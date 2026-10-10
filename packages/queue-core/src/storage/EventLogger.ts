import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

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

  private write(type: 'dispatch' | 'filter-miss' | 'diagnostic', entry: object): void {
    this.ensureDir();
    const file = join(this.logsDir, `${this.currentDateStr()}.ndjson`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), type, ...entry }) + '\n', 'utf-8');
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
