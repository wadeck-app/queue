import { lstatSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** A log file is kept this many days at most (counted from the date in its name). */
export const LOG_MAX_AGE_DAYS = 90;
/** The logs directory holds this many bytes at most (matching files only). */
export const LOG_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** A history file is kept this many days at most (counted from the date in its name). */
export const HISTORY_MAX_AGE_DAYS = 90;
/** The history directory holds this many bytes at most (matching files only). */
export const HISTORY_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// Only daemon logs (<day>.ndjson) and launcher logs (<day>-launcher.log); any other file is never touched
const LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(-launcher\.log|\.ndjson)$/;
// History: <day>.ndjson only, no launcher variant
const HISTORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(\.ndjson)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// A file written in the last minute may still be open for writing, whatever its name says
const RECENT_MTIME_MS = 60 * 1000;
// The Go launcher names its file with the host's local day (the daemon uses UTC), so its files get a day of margin
const LAUNCHER_RECENT_MTIME_MS = DAY_MS;
// No log can predate the Unix epoch: such a name is not a log file of ours
const FIRST_LOG_DAY_MS = 0;
// The age pass counts from the newest file's day plus this margin at most: a clock that jumped ahead (or a daemon idle for weeks) must not age the whole directory at once
const CLOCK_MARGIN_DAYS = 2;
// One run never deletes more than half of the files by age when it is more than this many files: that is a clock or configuration problem, not retention
const MASS_DELETE_MIN_FILES = 10;

/** Which directory is pruned: it selects the file names that may be deleted, the default limits and the wording of the messages. */
export type RetentionKind = 'logs' | 'history';

/** daemon: <day>.ndjson (UTC day); launcher: <day>-launcher.log (the Go launcher, host-local day). History has no launcher files. */
export type LogVariant = 'daemon' | 'launcher';

export const RETENTION_KINDS: readonly RetentionKind[] = ['logs', 'history'];
export const LOG_VARIANTS: readonly LogVariant[] = ['daemon', 'launcher'];

/** Why a file can never be deleted (by the retention or by hand) right now. */
export type ProtectionReason = 'today (UTC)' | 'today (local)' | 'future' | 'recently modified';

/** Test seams over the file system; the defaults are the real calls. */
export interface RetentionIo {
  unlink?: (path: string) => void;
  lstat?: (path: string) => Pick<Stats, 'size' | 'mtimeMs' | 'isFile'>;
}

/** Who reads the failure texts: the daemon (log lines) or the dashboard (a toast). It changes the `fix` wording only. */
export type RetentionAudience = 'daemon' | 'dashboard';

export interface PruneOptions extends RetentionIo {
  /** Default 'logs'. */
  kind?: RetentionKind;
  /** Default: LOG_MAX_AGE_DAYS or HISTORY_MAX_AGE_DAYS, by kind. */
  maxAgeDays?: number;
  /** Default: LOG_MAX_TOTAL_BYTES or HISTORY_MAX_TOTAL_BYTES, by kind. */
  maxTotalBytes?: number;
  /** The clock; the age of a file is measured against this day (UTC). */
  now: Date;
  /** Day (YYYY-MM-DD) that is never deleted, normally today. */
  keepDay: string;
  /** Default 'daemon'. */
  audience?: RetentionAudience;
  /** Delete nothing: `deleted` lists what a real run would delete (every deletion is assumed to succeed). */
  dryRun?: boolean;
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
  /** Files that vanished between the directory read and the deletion (deleted by someone else): a success, not listed in `deleted`. Absent when none. */
  alreadyGone?: string[];
}

interface LogFile {
  name: string;
  day: string;
  variant: LogVariant;
  bytes: number;
  mtimeMs: number;
  protectedReason?: ProtectionReason;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The time (ms since epoch, 00:00 UTC) of a real calendar day written YYYY-MM-DD, undefined for anything else.
 * V8 rolls 2026-02-30 over to March, so the date is parsed back and must print as the same text. Days before 1970 are refused.
 */
export function parseLogDay(day: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms) || ms < FIRST_LOG_DAY_MS) return undefined;
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : undefined;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// The host's local calendar day (what the Go launcher puts in its file name), offsetDays from the one of `date`
function localDay(date: Date, offsetDays = 0): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Why a file must not be deleted now, undefined when it may be. Shared by the retention and by the deletion of one file.
 * Protected: the UTC day of `now` and any later day (clock skew), for a launcher file also the host-local today and tomorrow
 * (the launcher's day boundary), and a file modified recently (a minute; a day for a launcher file). A modification time
 * later than `now` is protected too, like a future day in a name: a clock or file system that disagrees with ours means a writer may be active,
 * and deleting on that evidence is the unsafe side to err on.
 */
export function protectionReason(file: { day: string; variant: LogVariant; mtimeMs: number }, now: Date, keepDay?: string): ProtectionReason | undefined {
  const today = utcDay(now);
  if (file.day === today || file.day === keepDay) return 'today (UTC)';
  if (file.day > today) return 'future';
  if (file.variant === 'launcher') {
    if (file.day === localDay(now)) return 'today (local)';
    if (file.day === localDay(now, 1)) return 'future';
  }
  const age = now.getTime() - file.mtimeMs;
  const window = file.variant === 'launcher' ? LAUNCHER_RECENT_MTIME_MS : RECENT_MTIME_MS;
  // A negative age (mtime in the future) is protected on purpose, see above
  if (age < window) return 'recently modified';
  return undefined;
}

function classify(name: string, kind: RetentionKind): { day: string; variant: LogVariant } | undefined {
  const match = (kind === 'history' ? HISTORY_FILE_PATTERN : LOG_FILE_PATTERN).exec(name);
  if (!match) return undefined;
  const day = match[1]!;
  if (parseLogDay(day) === undefined) return undefined;
  return { day, variant: match[2] === '-launcher.log' ? 'launcher' : 'daemon' };
}

function fileNameOf(day: string, variant: LogVariant): string {
  return variant === 'launcher' ? `${day}-launcher.log` : `${day}.ndjson`;
}

function unlinkFix(path: string, code: string | undefined, audience: RetentionAudience): string {
  if (audience === 'daemon') {
    return `Close whatever holds ${path} open (an editor, a tail, antivirus) or delete it by hand; the next new day retries.`;
  }
  if (code === 'EBUSY' || code === 'EPERM') {
    return `${path} is held open by a running program, most likely the launcher (Windows refuses to delete an open file): it can be deleted once the launcher starts a new local day, or after "queue stop"; otherwise close the program that holds it.`;
  }
  return `Close whatever holds ${path} open (an editor, a tail, antivirus) or delete it by hand, then try again.`;
}

// Lists the matching files of an already-read directory; a file that vanished meanwhile is skipped, any other stat error is a failure
function collectLogFiles(dir: string, names: string[], kind: RetentionKind, io: RetentionIo): { files: LogFile[]; failures: PruneFailure[] } {
  const lstat = io.lstat ?? lstatSync;
  const files: LogFile[] = [];
  const failures: PruneFailure[] = [];
  for (const name of names) {
    const info = classify(name, kind);
    if (!info) continue;
    try {
      const stat = lstat(join(dir, name));
      // A directory or a link named like a log file is not ours to delete (unlink would fail every new day with advice that does not fit): it is reported, not counted
      if (!stat.isFile()) {
        failures.push({
          file: name,
          error: `${join(dir, name)} is not a regular file (a directory or a link named like a ${kind === 'history' ? 'history' : 'log'} file)`,
          fix: `Remove or rename ${join(dir, name)} by hand: the retention only deletes regular files, and ignores this one (it is not counted in the sizes) until then.`,
        });
        continue;
      }
      files.push({ name, ...info, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch (err) {
      // Gone between the directory read and now: nothing to retain
      if (errorCode(err) === 'ENOENT') continue;
      failures.push({
        file: name,
        error: errorMessage(err),
        fix: `Check that ${join(dir, name)} is readable; it is skipped by the ${kind === 'history' ? 'history' : 'log'} retention.`,
      });
    }
  }
  return { files, failures };
}

interface Policy {
  kind: RetentionKind;
  dir: string;
  maxAgeDays: number;
  maxTotalBytes: number;
  now: Date;
  keepDay: string;
}

function policyOf(dir: string, options: { kind?: RetentionKind; maxAgeDays?: number; maxTotalBytes?: number; now: Date; keepDay: string }): Policy {
  const kind = options.kind ?? 'logs';
  const isHistory = kind === 'history';
  return {
    kind,
    dir,
    maxAgeDays: options.maxAgeDays ?? (isHistory ? HISTORY_MAX_AGE_DAYS : LOG_MAX_AGE_DAYS),
    maxTotalBytes: options.maxTotalBytes ?? (isHistory ? HISTORY_MAX_TOTAL_BYTES : LOG_MAX_TOTAL_BYTES),
    now: options.now,
    keepDay: options.keepDay,
  };
}

/**
 * The one retention policy: age (by the date in the name), then whole days oldest first while over the size cap.
 * Protected files (see protectionReason) are never removed. `remove` performs (or records) one deletion and says whether it worked;
 * the size pass depends on that answer, which is why the policy cannot be a pure plan.
 */
function applyPolicy(files: LogFile[], policy: Policy, remove: (file: LogFile, reason: string) => boolean, report: PruneReport): LogFile[] {
  const isHistory = policy.kind === 'history';
  for (const f of files) {
    const reason = protectionReason(f, policy.now, policy.keepDay);
    if (reason) f.protectedReason = reason;
  }

  // Step 1: age, counted from the clock but never from further than CLOCK_MARGIN_DAYS after the newest file: after a forward clock jump
  // or a long idle, "now" says nothing about what is old, and trusting it deleted the whole directory (including yesterday)
  const nowDayMs = Date.UTC(policy.now.getUTCFullYear(), policy.now.getUTCMonth(), policy.now.getUTCDate());
  const newestDayMs = files.reduce((max, f) => Math.max(max, parseLogDay(f.day)!), -Infinity);
  const anchorMs = Math.min(nowDayMs, newestDayMs + CLOCK_MARGIN_DAYS * DAY_MS);
  const warnings: string[] = [];
  const label = isHistory ? 'history' : 'log';
  if (files.length > 0 && nowDayMs > anchorMs) {
    const newestDay = new Date(newestDayMs).toISOString().slice(0, 10);
    const ahead = Math.round((nowDayMs - newestDayMs) / DAY_MS);
    warnings.push(
      `The clock is ${ahead} days ahead of the newest ${label} file (${newestDay}): the daemon was idle that long or the system clock jumped forward. ` +
        `The ${policy.maxAgeDays}-day age limit is counted from ${new Date(anchorMs).toISOString().slice(0, 10)} instead of today, so nothing newer than that is deleted: the age retention is held back until the clock is sane or a new day file exists. Check the system date.`,
    );
  }
  const ageReason = `older than ${policy.maxAgeDays} days`;
  const overAge = (f: LogFile): boolean => !f.protectedReason && (anchorMs - parseLogDay(f.day)!) / DAY_MS > policy.maxAgeDays;
  const agedCount = files.filter(overAge).length;
  // A file whose deletion just failed is not tried again by the size pass (one failure entry per file)
  const failedToRemove = new Set<LogFile>();
  const massDelete = agedCount > MASS_DELETE_MIN_FILES && agedCount > files.length / 2;
  if (massDelete) {
    warnings.push(
      `The age retention would delete ${agedCount} of ${files.length} ${label} files in one run, which looks like a clock or configuration problem, so it deleted none of them. ` +
        `If they are really obsolete, delete them by hand in ${policy.dir} or from the Log files page of the dashboard.`,
    );
  }
  let kept = files.filter(f => {
    if (!overAge(f) || massDelete) return true;
    if (remove(f, ageReason)) return false;
    failedToRemove.add(f);
    return true;
  });

  // Step 2: total size, whole days oldest first
  const total = (): number => kept.reduce((sum, f) => sum + f.bytes, 0);
  const sizeReason = `total size over ${Math.round(policy.maxTotalBytes / (1024 * 1024))} MB`;
  const removable = (f: LogFile): boolean => !f.protectedReason && !failedToRemove.has(f);
  const days = [...new Set(kept.filter(removable).map(f => f.day))].sort();
  for (const day of days) {
    if (total() <= policy.maxTotalBytes) break;
    for (const f of kept.filter(x => x.day === day && removable(x))) {
      if (remove(f, sizeReason)) kept = kept.filter(x => x !== f);
    }
  }

  report.remainingBytes = total();
  const ageWarning = warnings.join(' ');
  if (ageWarning !== '') report.warning = ageWarning;
  if (report.remainingBytes > policy.maxTotalBytes) {
    if (kept.every(f => f.protectedReason)) {
      if (kept.every(f => f.day === policy.keepDay)) {
        const keptBytes = total();
        report.warning = isHistory
          ? `History of ${policy.keepDay} alone uses ${keptBytes} bytes, over the ${policy.maxTotalBytes} byte cap; nothing more can be deleted. Find the event pushed too often or with a huge payload with "queue history" and reduce it.`
          : `Logs of ${policy.keepDay} alone use ${keptBytes} bytes, over the ${policy.maxTotalBytes} byte cap; nothing more can be deleted. Find the noisy subscriber with "queue logs" and reduce its output.`;
      } else {
        report.warning = isHistory
          ? `The protected history files (today, future-dated or recently modified) alone use ${report.remainingBytes} bytes, over the ${policy.maxTotalBytes} byte cap; nothing more can be deleted now. Find the event pushed too often or with a huge payload with "queue history" and reduce it.`
          : `The protected log files (today, future-dated or recently modified) alone use ${report.remainingBytes} bytes, over the ${policy.maxTotalBytes} byte cap; nothing more can be deleted now. Find the noisy subscriber with "queue logs" and reduce its output.`;
      }
    } else {
      report.warning = `${isHistory ? 'History still uses' : 'Logs still use'} ${report.remainingBytes} bytes, over the ${policy.maxTotalBytes} byte cap, because some files could not be deleted (see failures).`;
    }
    // The size warning follows the age warning: both are true and the user needs both
    if (ageWarning !== '') report.warning = `${ageWarning} ${report.warning}`;
  }
  return kept;
}

/**
 * Deletes logs older than `maxAgeDays` (by the date in the name, not mtime), then whole days oldest first
 * while the total size is over `maxTotalBytes`. `keepDay` and any other protected file (see protectionReason) is never deleted.
 * A file already gone is a success. Never throws on a file error: failures are reported, see PruneReport.
 * With `dryRun`, nothing is deleted and `deleted` is what a real run would delete.
 */
export function pruneLogDir(dir: string, options: PruneOptions): PruneReport {
  const policy = policyOf(dir, options);
  const unlink = options.unlink ?? unlinkSync;
  const audience = options.audience ?? 'daemon';
  const { files, failures } = collectLogFiles(dir, readdirSync(dir), policy.kind, options);
  const report: PruneReport = { deleted: [], failures, remainingBytes: 0 };

  const remove = (file: LogFile, reason: string): boolean => {
    if (options.dryRun) {
      report.deleted.push({ file: file.name, bytes: file.bytes, reason });
      return true;
    }
    try {
      unlink(join(dir, file.name));
      report.deleted.push({ file: file.name, bytes: file.bytes, reason });
      return true;
    } catch (err) {
      // Someone else (the daemon at midnight, the dashboard) deleted it first: the goal is reached
      if (errorCode(err) === 'ENOENT') {
        (report.alreadyGone ??= []).push(file.name);
        return true;
      }
      report.failures.push({
        file: file.name,
        error: errorMessage(err),
        fix: unlinkFix(join(dir, file.name), errorCode(err), audience),
      });
      return false;
    }
  };

  applyPolicy(files, policy, remove, report);
  return report;
}

export interface ListLogFilesOptions extends RetentionIo {
  kind: RetentionKind;
  now: Date;
  maxAgeDays?: number;
  maxTotalBytes?: number;
}

export interface LogFileInfo {
  name: string;
  kind: RetentionKind;
  variant: LogVariant;
  /** YYYY-MM-DD: UTC for a daemon log and for history, host-local for a launcher log. */
  day: string;
  bytes: number;
  mtimeMs: number;
  /** True when the file can be deleted by nobody now, see protectionReason. */
  protected: boolean;
  protectedReason?: ProtectionReason;
  /** Why the retention would delete it now (same policy and code as pruneLogDir); absent when it would keep it. */
  pruneReason?: string;
}

export interface LogFileListing {
  kind: RetentionKind;
  dir: string;
  /** False when the directory does not exist: not an error, an empty listing. */
  exists: boolean;
  maxAgeDays: number;
  maxTotalBytes: number;
  totalBytes: number;
  /** Newest day first, the daemon file before the launcher file of a day. */
  files: LogFileInfo[];
  prunableCount: number;
  prunableBytes: number;
  /** What the retention would warn about after pruning (same text as PruneReport.warning). */
  warning?: string;
  /** Matching files that could not be read (they are not in `files`). */
  failures: PruneFailure[];
}

/**
 * The matching log files of a directory with the verdict of the retention on each, computed by the same policy code as pruneLogDir
 * (a dry run), so the preview cannot drift from the deletion. A missing directory is an empty listing; an unreadable existing one throws.
 */
export function listLogFiles(dir: string, options: ListLogFilesOptions): LogFileListing {
  const policy = policyOf(dir, { ...options, keepDay: utcDay(options.now) });
  const listing: LogFileListing = {
    kind: policy.kind,
    dir,
    exists: true,
    maxAgeDays: policy.maxAgeDays,
    maxTotalBytes: policy.maxTotalBytes,
    totalBytes: 0,
    files: [],
    prunableCount: 0,
    prunableBytes: 0,
    failures: [],
  };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { ...listing, exists: false };
    throw new Error(`Cannot read the ${policy.kind} directory ${dir}: ${errorMessage(err)}. Check that it is a readable directory (permissions, not a file), then reload the page.`);
  }
  const { files, failures } = collectLogFiles(dir, names, policy.kind, options);
  const planned = new Map<string, string>();
  const report: PruneReport = { deleted: [], failures: [], remainingBytes: 0 };
  applyPolicy(files, policy, (file, reason) => {
    planned.set(file.name, reason);
    return true;
  }, report);

  listing.failures = failures;
  listing.totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  listing.files = files
    .map((f): LogFileInfo => ({
      name: f.name,
      kind: policy.kind,
      variant: f.variant,
      day: f.day,
      bytes: f.bytes,
      mtimeMs: f.mtimeMs,
      protected: f.protectedReason !== undefined,
      ...(f.protectedReason !== undefined && { protectedReason: f.protectedReason }),
      ...(planned.has(f.name) && { pruneReason: planned.get(f.name)! }),
    }))
    .sort((a, b) => (a.day === b.day ? a.variant.localeCompare(b.variant) : a.day < b.day ? 1 : -1));
  listing.prunableCount = planned.size;
  listing.prunableBytes = files.filter(f => planned.has(f.name)).reduce((sum, f) => sum + f.bytes, 0);
  if (report.warning) listing.warning = report.warning;
  return listing;
}

/** A kind, day or variant that is not one of the accepted values: the message names the value (truncated) and the accepted ones. */
export class InvalidLogFileError extends Error {}

// The echo of a rejected value stays short whatever the caller sent
function quote(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
}

export interface LogFileRef {
  kind: string;
  day: string;
  variant: string;
}

export interface DeleteLogFileOptions extends RetentionIo {
  now: Date;
}

export type DeleteLogFileResult =
  | { status: 'deleted'; file: string; bytes: number }
  /** Not there (any more): the goal is reached, not an error. */
  | { status: 'already-gone'; file: string }
  /** Protected, see protectionReason; nothing was touched. */
  | { status: 'refused'; file: string; reason: ProtectionReason; message: string }
  /** That combination has no files (history has no launcher variant). */
  | { status: 'unsupported'; message: string }
  /** The file exists but is not a regular file, or could not be read or deleted; nothing more was done. */
  | { status: 'failed'; file: string; error: string; fix: string };

/**
 * Deletes ONE log file named by (kind, day, variant), never by a path: the name is built here from validated parts.
 * Throws InvalidLogFileError for a malformed kind, variant or day. A protected file is refused with its reason, a missing one is a success.
 */
export function deleteLogFile(dir: string, ref: LogFileRef, options: DeleteLogFileOptions): DeleteLogFileResult {
  if (!(RETENTION_KINDS as readonly string[]).includes(ref.kind)) {
    throw new InvalidLogFileError(`kind must be one of ${RETENTION_KINDS.join(', ')}, got: ${quote(ref.kind)}`);
  }
  if (!(LOG_VARIANTS as readonly string[]).includes(ref.variant)) {
    throw new InvalidLogFileError(`variant must be one of ${LOG_VARIANTS.join(', ')}, got: ${quote(ref.variant)}`);
  }
  if (parseLogDay(ref.day) === undefined) {
    throw new InvalidLogFileError(`day must be a day as YYYY-MM-DD, got: ${quote(ref.day)}`);
  }
  const kind = ref.kind as RetentionKind;
  const variant = ref.variant as LogVariant;
  if (kind === 'history' && variant === 'launcher') {
    return { status: 'unsupported', message: 'The history has no launcher files; use variant "daemon" for kind "history".' };
  }

  const name = fileNameOf(ref.day, variant);
  const path = join(dir, name);
  // Belt and braces: the name came from validated parts, so these can only fail on a bug
  const info = classify(name, kind);
  if (!info || info.day !== ref.day || info.variant !== variant || basename(path) !== name || dirname(resolve(path)) !== resolve(dir)) {
    throw new Error(`Refusing to delete ${path}: it does not resolve to a ${kind} file of ${dir}. This is a bug in the queue, please report it.`);
  }

  const lstat = options.lstat ?? lstatSync;
  const unlink = options.unlink ?? unlinkSync;
  let stat: Pick<Stats, 'size' | 'mtimeMs' | 'isFile'>;
  try {
    stat = lstat(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { status: 'already-gone', file: name };
    return { status: 'failed', file: name, error: errorMessage(err), fix: `Check that ${path} is readable (permissions), then try again.` };
  }
  if (!stat.isFile()) {
    return { status: 'failed', file: name, error: `${path} is not a regular file`, fix: `Remove or rename ${path} by hand: the queue only deletes regular files.` };
  }
  const reason = protectionReason({ day: ref.day, variant, mtimeMs: stat.mtimeMs }, options.now);
  if (reason) {
    return {
      status: 'refused',
      file: name,
      reason,
      message: `${name} is protected (${reason}) and cannot be deleted now: it may still be written to. Try again after the day change and once the file has not been modified for ${variant === 'launcher' ? '24 hours' : 'a minute'}.`,
    };
  }
  try {
    unlink(path);
    return { status: 'deleted', file: name, bytes: stat.size };
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { status: 'already-gone', file: name };
    return { status: 'failed', file: name, error: errorMessage(err), fix: unlinkFix(path, errorCode(err), 'dashboard') };
  }
}

export interface QueueFileInfo {
  name: 'wal.ndjson' | 'dlq.ndjson';
  path: string;
  exists: boolean;
  bytes: number;
  mtimeMs?: number;
}

/** Size and modification time of the WAL and the dead-letter queue, for display only: nothing in this module deletes or edits them. */
export function statQueueFiles(configDir: string, io: Pick<RetentionIo, 'lstat'> = {}): QueueFileInfo[] {
  const lstat = io.lstat ?? lstatSync;
  return (['wal.ndjson', 'dlq.ndjson'] as const).map(name => {
    const path = join(configDir, name);
    try {
      const stat = lstat(path);
      return { name, path, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return { name, path, exists: false, bytes: 0 };
      throw new Error(`Cannot read ${path}: ${errorMessage(err)}. Check its permissions, then reload the page.`);
    }
  });
}

export interface RetentionLine {
  level: 'info' | 'warn';
  message: string;
}

/**
 * What a prune report says, as the lines to log: one info line for the deleted files, one warn line for the warning and the failures.
 * `label` starts every message ('Log' or 'History', giving "Log retention deleted ...").
 */
export function describeRetention(label: string, report: PruneReport): RetentionLine[] {
  const lines: RetentionLine[] = [];
  if (report.deleted.length > 0) {
    const freed = report.deleted.reduce((sum, d) => sum + d.bytes, 0);
    const what = report.deleted.map(d => `${d.file} (${d.reason})`).join(', ');
    lines.push({ level: 'info', message: `${label} retention deleted ${report.deleted.length} file(s), ${freed} bytes freed: ${what}` });
  }
  const problems = report.failures.map(f => `${f.file}: ${f.error}. ${f.fix}`);
  if (report.warning) problems.unshift(report.warning);
  if (problems.length > 0) {
    lines.push({ level: 'warn', message: `${label} retention: ${problems.join(' | ')}` });
  }
  return lines;
}
