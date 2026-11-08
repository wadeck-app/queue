import { mkdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FileLock, processIsAlive } from '../storage/FileLock.js';
import type { RetentionLine } from '../storage/LogRetention.js';
import { WaiterHistoryLog, waiterHistoryDir, waitersDir, type WaiterOutcome } from './WaiterHistory.js';
import { WAITER_TTL_MS, defaultWaiterFs, errorCode, errorText, isWaiterLive, type WaiterFs } from './WaiterLiveness.js';
import { WAITER_RECORD_VERSION, WAITER_LIMITS, parseWaiterRecord, validateWaiterInput, type WaiterInput, type WaiterRecord } from './WaiterRecord.js';
import { waiterFileName, waiterNameOfFile } from './waiterName.js';

/** The registration of a wait was refused: the input is not valid (the message says what to fix). */
export class WaiterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaiterInputError';
  }
}

/** A live wait already holds the name. `holder` is who, so the message can name them. */
export class WaiterNameTakenError extends Error {
  constructor(readonly holder: WaiterRecord) {
    super(`--name '${holder.name}' is already used by a live wait (pid ${holder.pid}, since ${holder.startedAt}, waiting for ${holder.events.join(', ')}): each concurrent wait needs its own name. Fix: choose another name (put what you wait for in it), or stop pid ${holder.pid}.`);
    this.name = 'WaiterNameTakenError';
  }
}

/** What a registration found in its way and replaced. */
export interface WaiterTakeover {
  /** Absent for an unreadable record. */
  pid?: number;
  startedAt?: string;
  reason: 'process gone' | `no heartbeat for ${number} s` | 'unreadable record';
}

/** What a wait keeps from `register` to hand back to `heartbeat` and `deregister`. */
export interface WaiterRegistration {
  id: string;
  name: string;
  path: string;
  pid: number;
  startedAt: string;
  record: WaiterRecord;
  takeover?: WaiterTakeover;
}

export type HeartbeatResult =
  | { status: 'ok' }
  | { status: 'reregistered' }
  /** Another live wait owns the name now: this one keeps running, invisible. Say so once. */
  | { status: 'lost'; message: string }
  /** The file could not be touched; the next heartbeat tries again. Say so once. */
  | { status: 'failed'; message: string };

export interface WaiterEnd {
  outcome: Exclude<WaiterOutcome, 'lost' | 'refused'>;
  /** For `matched`: the event that satisfied the wait. */
  eventId?: string;
  event?: string;
}

export interface SweepReport {
  /** Names of the files removed (their waits were over). */
  removed: string[];
  /** Files left alone because they cannot be read, each with the path and the reason. */
  problems: string[];
}

export interface WaiterRegistryDeps {
  /** Identity of this process (the lock, the record). Default: this process. */
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  newId?: () => string;
  /** Blocking sleep of the lock while another process holds it. */
  sleep?: (ms: number) => void;
  fs?: Partial<WaiterFs>;
  history?: WaiterHistoryLog;
  /** What the waits history retention reports. Default: stderr. */
  onRetention?: (lines: RetentionLine[]) => void;
  /** A problem that did not stop the operation (a journal that cannot be written). Default: stderr. */
  onDiagnostic?: (message: string) => void;
  ttlMs?: number;
}

type Holder =
  | { kind: 'none' }
  | { kind: 'record'; record: WaiterRecord; mtimeMs: number }
  | { kind: 'unusable'; problem: string };

type Claim = { placed: true; takeover?: WaiterTakeover } | { placed: false; holder: WaiterRecord };

const TOUCH_ATTEMPTS = 3;

/**
 * The files of the waiting `queue wait` processes: `<configDir>/waiters/waiter-<name>.json`, written by the wait itself. This class is the wait's side: register, heartbeat,
 * deregister, and the sweep of the files of waits that are over. Reading them to count waiters is {@link listLiveWaiters}.
 *
 * Every change of a file happens under one `FileLock` (`waiters/waiters.lock`): two waits that find the same stale holder cannot both replace it, and the journal
 * `lost` record is written once. A heartbeat only touches the file's modification time (no rewrite: no torn read, no rename that Windows refuses).
 * The wait's `id` (random per registration) is what proves ownership: a reused pid or name is never mistaken for the owner.
 */
export class WaiterRegistry {
  private readonly dir: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly newId: () => string;
  private readonly sleep: ((ms: number) => void) | undefined;
  private readonly fs: WaiterFs;
  private readonly history: WaiterHistoryLog;
  private readonly onDiagnostic: (message: string) => void;
  private readonly ttlMs: number;

  constructor(private readonly configDir: string, deps: WaiterRegistryDeps = {}) {
    this.dir = waitersDir(configDir);
    this.pid = deps.pid ?? process.pid;
    this.now = deps.now ?? Date.now;
    this.isAlive = deps.isAlive ?? processIsAlive;
    this.newId = deps.newId ?? (() => randomUUID().replaceAll('-', ''));
    this.sleep = deps.sleep;
    this.fs = { ...defaultWaiterFs, ...deps.fs };
    this.onDiagnostic = deps.onDiagnostic ?? ((message) => { process.stderr.write(`[queue] ${message}\n`); });
    this.history = deps.history ?? new WaiterHistoryLog(waiterHistoryDir(configDir), { now: () => new Date(this.now()), ...(deps.onRetention !== undefined && { onRetention: deps.onRetention }) });
    this.ttlMs = deps.ttlMs ?? WAITER_TTL_MS;
  }

  /**
   * Makes the wait visible: writes its file and its `start` record. Throws {@link WaiterInputError} for an input that is not valid, {@link WaiterNameTakenError} when a live
   * wait holds the name (the refusal is journaled), and a plain Error naming the folder when it cannot be written (the wait must not run unregistered).
   * A holder that is gone (process dead) or silent for more than the TTL is replaced; `takeover` says whom.
   */
  register(input: WaiterInput): WaiterRegistration {
    const problem = validateWaiterInput(input);
    if (problem !== undefined) {
      throw new WaiterInputError(problem);
    }
    const now = this.now();
    const record: WaiterRecord = {
      v: WAITER_RECORD_VERSION,
      id: this.newId(),
      name: input.name,
      events: [...input.events],
      whens: [...input.whens],
      label: input.label,
      contact: input.contact ?? { kind: 'none' },
      pid: this.pid,
      cwd: input.cwd,
      since: input.since,
      startedAt: new Date(now).toISOString(),
    };
    const claim = this.locked(`register the wait '${input.name}'`, () => this.claim(record, true));
    if (!claim.placed) {
      this.journalSafely(() => {
        this.history.recordStart(record);
        this.history.recordEnd({ kind: 'end', id: record.id, name: record.name, endedAt: record.startedAt, durationMs: 0, outcome: 'refused' });
      });
      throw new WaiterNameTakenError(claim.holder);
    }
    return { id: record.id, name: record.name, path: join(this.dir, waiterFileName(record.name)), pid: record.pid, startedAt: record.startedAt, record, ...(claim.takeover !== undefined && { takeover: claim.takeover }) };
  }

  /**
   * Called every {@link WAITER_HEARTBEAT_MS}. Never throws. Touches the file; if the file is gone or was replaced (a stall longer than the TTL, a sweep), it is written again
   * with the same id, unless a live wait took the name meanwhile (`lost`).
   */
  heartbeat(registration: WaiterRegistration): HeartbeatResult {
    try {
      const holder = this.readHolder(registration.path, registration.name);
      if (holder.kind === 'record' && holder.record.id === registration.id) {
        const touched = this.touch(registration.path);
        if (touched === 'ok') {
          return { status: 'ok' };
        }
        if (touched !== 'gone') {
          return { status: 'failed', message: `could not refresh ${registration.path}: ${touched.error}. The wait goes on and tries again at the next heartbeat; if it keeps failing, another wait may take the name '${registration.name}' after ${Math.round(this.ttlMs / 1000)} s.` };
        }
      }
      const claim = this.locked(`refresh the wait '${registration.name}'`, () => this.claim(registration.record, false));
      if (!claim.placed) {
        return { status: 'lost', message: `the name '${registration.name}' is now used by another live wait (pid ${claim.holder.pid}, since ${claim.holder.startedAt}): this wait keeps running but is no longer listed. Fix: stop it and start it again with its own name.` };
      }
      return { status: 'reregistered' };
    } catch (error) {
      return { status: 'failed', message: `could not refresh ${registration.path}: ${errorText(error)}. The wait goes on and tries again at the next heartbeat.` };
    }
  }

  /**
   * Ends the registration: writes the `end` record (once per wait, and not when a sweep already recorded it as lost), then deletes the file if it is still ours.
   * True when the file was deleted. Never throws for a journal problem (said through `onDiagnostic`).
   */
  deregister(registration: WaiterRegistration, end?: WaiterEnd): boolean {
    return this.locked(`end the wait '${registration.name}'`, () => {
      if (end !== undefined) {
        this.journalSafely(() => {
          if (!this.history.hasEnd(registration.id, registration.startedAt)) {
            const at = this.now();
            this.history.recordEnd({
              kind: 'end',
              id: registration.id,
              name: registration.name,
              endedAt: new Date(at).toISOString(),
              durationMs: Math.max(0, at - Date.parse(registration.startedAt)),
              outcome: end.outcome,
              ...(end.eventId !== undefined && { eventId: end.eventId }),
              ...(end.event !== undefined && { event: end.event }),
            });
          }
        });
      }
      const holder = this.readHolder(registration.path, registration.name);
      if (holder.kind !== 'record' || holder.record.id !== registration.id) {
        return false;
      }
      return this.unlink(registration.path);
    });
  }

  /**
   * Removes the files of waits that are over (process gone or no heartbeat for the TTL) and records each as `lost` at its last heartbeat, once. A live wait is never touched;
   * a file that cannot be read stays and is reported. A missing folder is an empty sweep.
   */
  sweepStale(): SweepReport {
    const report: SweepReport = { removed: [], problems: [] };
    let names: string[];
    try {
      names = this.fs.readdir(this.dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return report;
      }
      throw error;
    }
    if (!names.some((name) => waiterNameOfFile(name) !== undefined)) {
      return report;
    }
    return this.locked('sweep the waits that are over', () => {
      for (const fileName of names) {
        const name = waiterNameOfFile(fileName);
        if (name === undefined) {
          continue;
        }
        const path = join(this.dir, fileName);
        const holder = this.readHolder(path, name);
        if (holder.kind === 'unusable') {
          report.problems.push(`${path}: ${holder.problem}`);
        } else if (holder.kind === 'record' && !this.live(holder)) {
          this.recordLost(holder.record, holder.mtimeMs);
          if (this.unlink(path)) {
            report.removed.push(name);
          }
        }
      }
      return report;
    });
  }

  private live(holder: { record: WaiterRecord; mtimeMs: number }): boolean {
    return isWaiterLive({ pid: holder.record.pid, mtimeMs: holder.mtimeMs }, this.now(), this.isAlive, this.ttlMs);
  }

  /** Runs `fn` under the registration lock. Any failure to create the folder or take the lock says which path and what to do. */
  private locked<T>(doing: string, fn: () => T): T {
    try {
      mkdirSync(this.dir, { recursive: true });
      const lock = new FileLock(join(this.dir, 'waiters.lock'), {
        pid: this.pid,
        now: this.now,
        isAlive: this.isAlive,
        ...(this.sleep !== undefined && { sleep: this.sleep }),
      });
      return lock.withLock(fn);
    } catch (error) {
      if (error instanceof WaiterNameTakenError || error instanceof WaiterInputError) {
        throw error;
      }
      throw new Error(`Cannot ${doing}: ${errorText(error)}. The wait is not started unregistered (a wait nobody can see is what the waiters list is for). Fix: check that ${this.dir} is a folder this user can write to (permissions, antivirus, a file with that name), then run it again.`, { cause: error });
    }
  }

  /**
   * Under the lock: puts `record` in its file unless a live wait of another id holds the name. The holder that is gone, silent or unreadable is replaced.
   * `journalStart`: a first registration writes its `start` record; the rewrite after a stall does not (same wait).
   */
  private claim(record: WaiterRecord, journalStart: boolean): Claim {
    const path = join(this.dir, waiterFileName(record.name));
    const holder = this.readHolder(path, record.name);
    let takeover: WaiterTakeover | undefined;
    if (holder.kind === 'record') {
      if (holder.record.id === record.id) {
        this.touch(path);
        return { placed: true };
      }
      if (this.live(holder)) {
        return { placed: false, holder: holder.record };
      }
      const processGone = !this.isAlive(holder.record.pid);
      takeover = { pid: holder.record.pid, startedAt: holder.record.startedAt, reason: processGone ? 'process gone' : `no heartbeat for ${Math.round(this.ttlMs / 1000)} s` };
      this.recordLost(holder.record, holder.mtimeMs);
      this.unlink(path);
    } else if (holder.kind === 'unusable') {
      takeover = { reason: 'unreadable record' };
      this.unlink(path);
    }
    this.write(path, record);
    if (journalStart) {
      this.journalSafely(() => { this.history.recordStart(record); });
    }
    return { placed: true, ...(takeover !== undefined && { takeover }) };
  }

  /** The file is written whole under another name and renamed into place, so a reader sees all of it or none. Its modification time is set to the clock of this registry. */
  private write(path: string, record: WaiterRecord): void {
    const temp = `${path}.tmp`;
    // Owner only; no effect on Windows
    writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600 });
    const at = new Date(this.now());
    utimesSync(temp, at, at);
    renameSync(temp, path);
  }

  private readHolder(path: string, name: string): Holder {
    const fileName = waiterFileName(name);
    try {
      const stat = this.fs.stat(path);
      if (stat.size > WAITER_LIMITS.maxFileBytes) {
        return { kind: 'unusable', problem: `${fileName} is over ${WAITER_LIMITS.maxFileBytes} bytes: it was not read` };
      }
      const parsed = parseWaiterRecord(this.fs.readFile(path), fileName);
      return parsed.ok ? { kind: 'record', record: parsed.record, mtimeMs: stat.mtimeMs } : { kind: 'unusable', problem: parsed.problem };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { kind: 'none' };
      }
      throw error;
    }
  }

  /** 'gone' when the file vanished; otherwise the error after {@link TOUCH_ATTEMPTS} attempts. */
  private touch(path: string): 'ok' | 'gone' | { error: string } {
    let last: unknown;
    for (let attempt = 0; attempt < TOUCH_ATTEMPTS; attempt++) {
      try {
        const at = new Date(this.now());
        this.fs.utimes(path, at, at);
        return 'ok';
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return 'gone';
        }
        last = error;
      }
    }
    return { error: errorText(last) };
  }

  private unlink(path: string): boolean {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /** A wait that was never ended: `endedAt` is its last heartbeat. Written once (not when an `end` exists). */
  private recordLost(record: WaiterRecord, mtimeMs: number): void {
    this.journalSafely(() => {
      if (this.history.hasEnd(record.id, record.startedAt)) {
        return;
      }
      this.history.recordEnd({
        kind: 'end',
        id: record.id,
        name: record.name,
        endedAt: new Date(mtimeMs).toISOString(),
        durationMs: Math.max(0, mtimeMs - Date.parse(record.startedAt)),
        outcome: 'lost',
      });
    });
  }

  /** The journal is secondary: a write that fails is said, and the registration goes on. */
  private journalSafely(write: () => void): void {
    try {
      write();
    } catch (error) {
      this.onDiagnostic(`could not write the waits history (${errorText(error)}); the wait is not affected. Check that ${waiterHistoryDir(this.configDir)} is writable and the disk has room.`);
    }
  }
}
