import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** A log file is kept this many days at most (counted from the date in its name). */
export const LOG_MAX_AGE_DAYS = 90;
/** The logs directory holds this many bytes at most (matching files only). */
export const LOG_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

// Only daemon logs (<day>.ndjson) and launcher logs (<day>-launcher.log); any other file is never touched
const LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(-launcher)?\.(ndjson|log)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  maxAgeDays?: number;
  maxTotalBytes?: number;
  /** The clock; the age of a file is measured against this day (UTC). */
  now: Date;
  /** Day (YYYY-MM-DD) that is never deleted, normally today. */
  keepDay: string;
}

export interface PrunedFile {
  file: string;
  bytes: number;
  reason: string;
}

export interface PruneFailure {
  file: string;
  /** Error message of the failed unlink. */
  error: string;
  /** What the user can do about it. */
  fix: string;
}

export interface PruneReport {
  deleted: PrunedFile[];
  failures: PruneFailure[];
  remainingBytes: number;
  warning?: string;
}

interface LogFile {
  name: string;
  day: string;
  bytes: number;
}

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Deletes logs older than `maxAgeDays` (by the date in the name, not mtime), then whole days oldest first
 * while the total size is over `maxTotalBytes`. `keepDay` is never deleted. Never throws on a file error:
 * failures are reported, see PruneReport.
 */
export function pruneLogDir(dir: string, options: PruneOptions): PruneReport {
  const maxAgeDays = options.maxAgeDays ?? LOG_MAX_AGE_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  const report: PruneReport = { deleted: [], failures: [], remainingBytes: 0 };

  let files: LogFile[] = [];
  for (const name of readdirSync(dir)) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) continue;
    const day = match[1]!;
    if (Number.isNaN(dayToMs(day))) continue;
    try {
      files.push({ name, day, bytes: statSync(join(dir, name)).size });
    } catch (err) {
      report.failures.push({
        file: name,
        error: err instanceof Error ? err.message : String(err),
        fix: `Check that ${join(dir, name)} is readable; it is skipped by the log retention.`,
      });
    }
  }

  const remove = (file: LogFile, reason: string): boolean => {
    try {
      unlinkSync(join(dir, file.name));
      report.deleted.push({ file: file.name, bytes: file.bytes, reason });
      return true;
    } catch (err) {
      report.failures.push({
        file: file.name,
        error: err instanceof Error ? err.message : String(err),
        fix: `Close whatever holds ${join(dir, file.name)} open (an editor, a tail, antivirus) or delete it by hand; the next new day retries.`,
      });
      return false;
    }
  };

  // Step 1: age
  const todayMs = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate());
  const ageReason = `older than ${maxAgeDays} days`;
  files = files.filter(f => {
    if (f.day === options.keepDay) return true;
    if ((todayMs - dayToMs(f.day)) / DAY_MS <= maxAgeDays) return true;
    return !remove(f, ageReason);
  });

  // Step 2: total size, whole days oldest first
  const total = (): number => files.reduce((sum, f) => sum + f.bytes, 0);
  const sizeReason = `total size over ${Math.round(maxTotalBytes / (1024 * 1024))} MB`;
  const days = [...new Set(files.map(f => f.day))].filter(d => d !== options.keepDay).sort();
  for (const day of days) {
    if (total() <= maxTotalBytes) break;
    for (const f of files.filter(x => x.day === day)) {
      if (remove(f, sizeReason)) files = files.filter(x => x !== f);
    }
  }

  report.remainingBytes = total();
  if (report.remainingBytes > maxTotalBytes) {
    const keptBytes = files.filter(f => f.day === options.keepDay).reduce((sum, f) => sum + f.bytes, 0);
    if (files.every(f => f.day === options.keepDay)) {
      report.warning = `Logs of ${options.keepDay} alone use ${keptBytes} bytes, over the ${maxTotalBytes} byte cap; nothing more can be deleted. Find the noisy subscriber with "queue logs" and reduce its output.`;
    } else {
      report.warning = `Logs still use ${report.remainingBytes} bytes, over the ${maxTotalBytes} byte cap, because some files could not be deleted (see failures).`;
    }
  }
  return report;
}
