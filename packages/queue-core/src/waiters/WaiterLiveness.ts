import { readFileSync, readdirSync, statSync, utimesSync, type Stats } from 'node:fs';
import { processIsAlive } from '../storage/FileLock.js';

/** A waiter is live while its process exists AND its file was touched this recently. The wait touches it every {@link WAITER_HEARTBEAT_MS}. */
export const WAITER_TTL_MS = 60_000;
export const WAITER_HEARTBEAT_MS = 15_000;

/**
 * Pid alone is wrong (Windows reuses pids, a laptop that slept keeps its process but not its place); the heartbeat alone is wrong (a crash would look live for a minute).
 * Both must hold. An mtime in the future (a clock that moved) counts as fresh.
 */
export function isWaiterLive(file: { pid: number; mtimeMs: number }, now: number, isAlive: (pid: number) => boolean = processIsAlive, ttlMs: number = WAITER_TTL_MS): boolean {
  return now - file.mtimeMs <= ttlMs && isAlive(file.pid);
}

/** The file system calls of the waiters, replaceable in tests. */
export interface WaiterFs {
  readdir: (dir: string) => string[];
  stat: (path: string) => Pick<Stats, 'size' | 'mtimeMs' | 'ino' | 'birthtimeMs'>;
  readFile: (path: string) => string;
  utimes: (path: string, atime: Date, mtime: Date) => void;
}

export const defaultWaiterFs: WaiterFs = {
  readdir: (dir) => readdirSync(dir),
  stat: (path) => statSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  utimes: (path, atime, mtime) => { utimesSync(path, atime, mtime); },
};

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
