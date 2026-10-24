/**
 * Test helpers that wait for a real condition instead of sleeping for a guessed duration.
 * The deadline is a hang guard, never a performance limit: a slow machine just waits longer.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { getErrorMessage } from '@wadeck-app/queue-core';

/** Hang guard shared by every wait below (same order of magnitude as the vitest testTimeout). */
export const HANG_GUARD_MS = 300_000;

const POLL_MS = 25;

/**
 * Polls `read` until it returns something other than undefined/false, and returns it.
 * `what` names the thing that never happened, so a hang is diagnosable from the failure message.
 */
export async function waitFor<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = HANG_GUARD_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms (hung?)`);
}

export interface OwnedProcess {
  child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves with the exit code once the process has ended (null when it was killed by a signal). */
  readonly exited: Promise<number | null>;
}

/** Spawns a process we own, collecting its output. Never kills it by itself: the caller does, or waits for `exited`. */
export function spawnOwned(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): OwnedProcess {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout?.on('data', (c) => { out += String(c); });
  child.stderr?.on('data', (c) => { err += String(c); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

/** Awaits a promise, failing with a "hung?" message after the hang guard instead of freezing the suite. */
export async function withHangGuard<T>(promise: Promise<T>, what: string, timeoutMs = HANG_GUARD_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${timeoutMs} ms (hung?)`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when something accepts TCP connections on the port. */
export function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, host);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** Waits until nothing listens on the port any more (the process that served it is on its way out). */
export async function waitForPortFree(port: number): Promise<void> {
  await waitFor(async () => !(await isPortListening(port)), `port ${port} to become free`);
}

/**
 * Removes a directory a child process may still hold for a moment (Windows keeps a directory locked while a process uses it as its
 * working directory, even briefly after the process exited): retries until it works, then fails naming the last error.
 */
export async function removeDirWhenFree(path: string): Promise<void> {
  let lastError = 'none';
  try {
    await waitFor(() => {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        return true;
      } catch (err) {
        lastError = getErrorMessage(err);
        return undefined;
      }
    }, `${path} to be removable`);
  } catch (err) {
    throw new Error(`${getErrorMessage(err)}; last error: ${lastError}`);
  }
}
