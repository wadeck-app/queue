import { join } from 'node:path';
import {
  EventLogger,
  InvalidLogFileError,
  RETENTION_KINDS,
  deleteLogFile,
  describeRetention,
  getErrorMessage,
  listLogFiles,
  pruneLogDir,
  statQueueFiles,
  type LogFileInfo,
  type LogFileListing,
  type PruneFailure,
  type PruneReport,
  type QueueFileInfo,
  type QueueLogWriter,
  type RetentionKind,
} from '@wadeck-app/queue-core';
import { InvalidQueryError, LogFileInUseError, LogFileNotFoundError } from './errors.js';

const SOURCE = 'LogFilesPage';

export interface LogFileRow {
  /** Unique across both sections, e.g. "logs:2026-10-24:launcher". */
  id: string;
  kind: RetentionKind;
  name: string;
  /** YYYY-MM-DD, in the zone of `dayZone`. */
  day: string;
  /** "2026-10-24 UTC" or "2026-10-24 local": what the table shows, so the zone is never a guess. */
  dayText: string;
  /** UTC for the daemon logs and the history, local for the launcher logs (the Go launcher names its file with the host's local day). */
  dayZone: 'UTC' | 'local';
  variant: 'daemon' | 'launcher';
  bytes: number;
  sizeText: string;
  modifiedMs: number;
  /** modifiedMs as an ISO time, the form the table's datetime format reads. */
  modifiedAt: string;
  /** protected: today, in the future or modified recently; prune: the retention would delete it now; kept: within retention. */
  status: 'protected' | 'prune' | 'kept';
  statusText: string;
  /** Why, alone: "older than 90 days", "today (UTC)", or "within retention". */
  reasonText: string;
  /** False for a protected file: the server refuses to delete it (409). */
  canDelete: boolean;
}

export interface LogFilesSection {
  kind: RetentionKind;
  label: string;
  /** The directory shown, so the user knows where to look. */
  dir: string;
  /** Markdown for the page: "Directory: `path`" (a code span keeps the backslashes of a Windows path). */
  dirText: string;
  exists: boolean;
  maxAgeDays: number;
  maxTotalBytes: number;
  maxTotalText: string;
  totalBytes: number;
  totalText: string;
  /** "64 MB of 100 MB (64%)". */
  usageText: string;
  /** 0 to 100 (capped), for a progress bar. */
  usagePercent: number;
  prunableCount: number;
  prunableBytes: number;
  /** "3 files, 12 MB" or "nothing". */
  prunableText: string;
  /** What the retention reports as a problem (cap exceeded by protected files, unreadable files); absent when none. */
  warning?: string;
  files: LogFileRow[];
}

export interface QueueFileRow {
  name: string;
  exists: boolean;
  bytes: number;
  sizeText: string;
  modifiedMs: number | null;
  /** modifiedMs as an ISO time for the table's datetime format; null when the file is absent. */
  modifiedAt: string | null;
}

export interface LastPrune {
  /** ISO time of the action. */
  at: string;
  /** What was done: "Pruned logs by policy" or "Deleted logs file 2026-10-10.ndjson". */
  what: string;
  message: string;
  /** One markdown sentence for the page: what, when, and that it is kept in memory only. */
  text: string;
}

export interface LogFilesResponse {
  /** UTC day of the server clock. */
  today: string;
  /** One markdown sentence for the page: the UTC day, the zone of the days, and which files are protected. */
  note: string;
  sections: LogFilesSection[];
  /** The same two section objects by name: the DSL has no index access (`sections[0]` renders nothing, silently), the page binds these. */
  logs: LogFilesSection;
  history: LogFilesSection;
  /** The WAL and the dead-letter queue: shown for information, never deleted from here. */
  queueFiles: QueueFileRow[];
  /** The last prune or deletion made since this module was loaded (lost when it reloads; the day log keeps the audit line). */
  lastPrune?: LastPrune;
}

export interface PruneLogFilesResponse {
  kind: RetentionKind;
  deleted: Array<{ file: string; bytes: number; reason: string }>;
  failures: PruneFailure[];
  /** Files that vanished before the deletion (deleted by someone else): not an error. */
  alreadyGone: string[];
  freedBytes: number;
  freedText: string;
  remainingBytes: number;
  remainingText: string;
  warning?: string;
  /** What the toast shows. */
  message: string;
}

export interface DeleteLogFileResponse {
  kind: RetentionKind;
  deleted: boolean;
  file: string;
  bytes: number;
  /** What the toast shows. */
  message: string;
}

let lastPrune: LastPrune | undefined;

function lastPruneOf(now: Date, what: string, message: string): LastPrune {
  return { at: now.toISOString(), what, message, text: `**Last action** (${now.toISOString()}): ${message}  \n_Kept in memory only: it disappears when the module restarts._` };
}

/** Forgets the last prune (tests; in the app it lives until the module is reloaded). */
export function clearLastPrune(): void {
  lastPrune = undefined;
}

/** 1536 -> "1.5 KB". Binary units, the same as the 100 MB / 200 MB caps. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${text} ${units[unit]}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function dirOf(configDir: string, kind: RetentionKind): string {
  return join(configDir, kind);
}

// The echo of a rejected value stays short whatever the caller sent
function quote(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
}

/** Same wording as the core's: kind must be one of logs, history, got: "x". */
export function parseKind(value: unknown): RetentionKind {
  if (typeof value === 'string' && (RETENTION_KINDS as readonly string[]).includes(value)) {
    return value as RetentionKind;
  }
  throw new InvalidQueryError(`kind must be one of ${RETENTION_KINDS.join(', ')}, got: ${quote(value)}`);
}

function statusOf(file: LogFileInfo): { status: LogFileRow['status']; statusText: string } {
  if (file.protected) {
    return { status: 'protected', statusText: `protected (${file.protectedReason ?? 'in use'})` };
  }
  if (file.pruneReason !== undefined) {
    return { status: 'prune', statusText: `to prune (${file.pruneReason})` };
  }
  return { status: 'kept', statusText: 'kept' };
}

function rowOf(file: LogFileInfo): LogFileRow {
  return {
    id: `${file.kind}:${file.day}:${file.variant}`,
    kind: file.kind,
    name: file.name,
    day: file.day,
    dayText: `${file.day} ${file.variant === 'launcher' ? 'local' : 'UTC'}`,
    dayZone: file.variant === 'launcher' ? 'local' : 'UTC',
    variant: file.variant,
    bytes: file.bytes,
    sizeText: formatBytes(file.bytes),
    modifiedMs: file.mtimeMs,
    modifiedAt: new Date(file.mtimeMs).toISOString(),
    ...statusOf(file),
    reasonText: file.protectedReason ?? file.pruneReason ?? 'within retention',
    canDelete: !file.protected,
  };
}

function sectionOf(listing: LogFileListing): LogFilesSection {
  const percent = listing.maxTotalBytes > 0 ? Math.round((listing.totalBytes / listing.maxTotalBytes) * 100) : 0;
  const problems: string[] = [];
  if (listing.warning) problems.push(listing.warning);
  for (const failure of listing.failures) {
    problems.push(`${failure.file} could not be read: ${failure.error}. ${failure.fix}`);
  }
  return {
    kind: listing.kind,
    label: listing.kind === 'logs' ? 'Logs' : 'History',
    dir: listing.dir,
    dirText: `Directory: \`${listing.dir}\``,
    exists: listing.exists,
    maxAgeDays: listing.maxAgeDays,
    maxTotalBytes: listing.maxTotalBytes,
    maxTotalText: formatBytes(listing.maxTotalBytes),
    totalBytes: listing.totalBytes,
    totalText: formatBytes(listing.totalBytes),
    usageText: `${formatBytes(listing.totalBytes)} of ${formatBytes(listing.maxTotalBytes)} (${percent}%)`,
    usagePercent: Math.min(100, percent),
    prunableCount: listing.prunableCount,
    prunableBytes: listing.prunableBytes,
    prunableText: listing.prunableCount === 0 ? 'nothing' : `${plural(listing.prunableCount, 'file')}, ${formatBytes(listing.prunableBytes)}`,
    ...(problems.length > 0 && { warning: problems.join(' | ') }),
    files: listing.files.map(rowOf),
  };
}

function queueRowOf(info: QueueFileInfo): QueueFileRow {
  return { name: info.name, exists: info.exists, bytes: info.bytes, sizeText: info.exists ? formatBytes(info.bytes) : 'absent', modifiedMs: info.mtimeMs ?? null, modifiedAt: info.mtimeMs === undefined ? null : new Date(info.mtimeMs).toISOString() };
}

/**
 * The log and history files with their size, date and what the retention would do with each (same code as the real prune), plus the WAL and
 * DLQ sizes for information. A missing directory is an empty section; an unreadable one throws with the fix.
 */
export function getLogFiles(configDir: string, now: Date = new Date()): LogFilesResponse {
  const sections = RETENTION_KINDS.map(kind => sectionOf(listLogFiles(dirOf(configDir, kind), { kind, now })));
  return {
    today: now.toISOString().slice(0, 10),
    note: `Today (UTC) is **${now.toISOString().slice(0, 10)}**. Days are UTC, except the launcher logs, which use the local day of this machine. Files are kept for the last 91 calendar days (today and the 90 before), counted from the newest file when the clock is more than 2 days ahead of it. Never deleted: today's file (for a launcher log also the local today and tomorrow), a future day, and a file modified in the last minute (24 hours for a launcher log) or with a modification time in the future.`,
    sections,
    logs: sections[0]!,
    history: sections[1]!,
    queueFiles: statQueueFiles(configDir).map(queueRowOf),
    ...(lastPrune !== undefined && { lastPrune }),
  };
}

// The audit trail: one line in the day log. Never throws; returns a sentence to append to the message when the line could not be written.
function audit(logger: QueueLogWriter | undefined, configDir: string, level: 'info' | 'warn', message: string): string {
  try {
    (logger ?? new EventLogger(join(configDir, 'logs'))).logDiagnostic({ source: SOURCE, level, message });
    return '';
  } catch (err) {
    return ` The audit line could not be written to the day log: ${getErrorMessage(err)}. Check that ${join(configDir, 'logs')} is writable.`;
  }
}

/**
 * Deletes the files the retention policy would delete now, in one directory, recomputed here (never the preview the page showed).
 * Per-file failures come back in the response, not as an error; an unreadable directory throws.
 */
export function pruneLogFiles(configDir: string, kindValue: unknown, now: Date = new Date(), logger?: QueueLogWriter): PruneLogFilesResponse {
  const kind = parseKind(kindValue);
  const dir = dirOf(configDir, kind);
  const noun = kind === 'logs' ? 'log' : 'history';
  // Throws a message with the fix when the directory exists but cannot be read; a missing one has nothing to prune
  const listing = listLogFiles(dir, { kind, now });
  const report: PruneReport = listing.exists
    ? pruneLogDir(dir, { kind, now, keepDay: now.toISOString().slice(0, 10), audience: 'dashboard' })
    : { deleted: [], failures: [], remainingBytes: 0 };
  const freedBytes = report.deleted.reduce((sum, d) => sum + d.bytes, 0);
  const alreadyGone = report.alreadyGone ?? [];
  const warning = report.warning;

  let message = report.deleted.length === 0
    ? `Nothing to prune in the ${noun} files.`
    : `Deleted ${plural(report.deleted.length, `${noun} file`)}, ${formatBytes(freedBytes)} freed.`;
  if (report.failures.length > 0) {
    message += ` ${plural(report.failures.length, 'file')} could not be deleted: ${report.failures.map(f => `${f.file}: ${f.error}. ${f.fix}`).join(' | ')}`;
  }
  if (warning) message += ` ${warning}`;

  const lines = describeRetention(kind === 'logs' ? 'Dashboard log' : 'Dashboard history', report);
  const auditMessage = lines.length > 0
    ? lines.map(l => l.message).join(' || ')
    : `Dashboard ${noun} prune by policy: nothing to delete`;
  const auditProblem = audit(logger, configDir, report.failures.length > 0 || warning ? 'warn' : 'info', auditMessage);
  message += auditProblem;
  lastPrune = lastPruneOf(now, `Pruned ${kind} by policy`, message);

  return {
    kind,
    deleted: report.deleted,
    failures: report.failures,
    alreadyGone,
    freedBytes,
    freedText: formatBytes(freedBytes),
    remainingBytes: report.remainingBytes,
    remainingText: formatBytes(report.remainingBytes),
    ...(warning !== undefined && { warning }),
    message,
  };
}

/**
 * Deletes one file named by (kind, day, variant), never by a path. InvalidQueryError (400) for a malformed value, LogFileNotFoundError (404)
 * for the history launcher combination, LogFileInUseError (409) for a protected file; a file already gone is a success (`deleted: false`).
 * Any other failure throws an Error whose message carries the cause and the fix.
 */
export function deleteLogFileEntry(configDir: string, kindValue: unknown, day: unknown, variant: unknown, now: Date = new Date(), logger?: QueueLogWriter): DeleteLogFileResponse {
  const kind = parseKind(kindValue);
  const dir = dirOf(configDir, kind);
  let result;
  try {
    result = deleteLogFile(dir, { kind, day: String(day), variant: String(variant) }, { now });
  } catch (err) {
    if (err instanceof InvalidLogFileError) throw new InvalidQueryError(err.message);
    throw err;
  }
  switch (result.status) {
    case 'unsupported':
      throw new LogFileNotFoundError(result.message);
    case 'refused':
      throw new LogFileInUseError(result.message);
    case 'failed':
      throw new Error(`${result.file} could not be deleted: ${result.error}. ${result.fix}`);
    case 'already-gone':
      return { kind, deleted: false, file: result.file, bytes: 0, message: `${result.file} was already gone.` };
    case 'deleted': {
      let message = `Deleted ${kind} file ${result.file} (${formatBytes(result.bytes)}).`;
      message += audit(logger, configDir, 'info', `Dashboard deleted the ${kind} file ${result.file} (${result.bytes} bytes)`);
      lastPrune = lastPruneOf(now, `Deleted ${kind} file ${result.file}`, message);
      return { kind, deleted: true, file: result.file, bytes: result.bytes, message };
    }
  }
}
