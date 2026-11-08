import { createHash } from 'node:crypto';
import { tmpdir as osTmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { waiterNameProblem } from './waiterName.js';

/**
 * The wake of a waiting `queue wait`: after the history write of a push the daemon connects to the wait's named pipe (Windows) or unix socket (POSIX) and sends one short line.
 * It is a HINT ("look at the history now"): the wait decides a match from the history only, and keeps polling, so a lost, late or forged wake changes nothing.
 *
 * The address is DERIVED from the config dir and the validated waiter name, never read from a file: the daemon recomputes it and refuses a record that says otherwise.
 * This file is the pure part (derivation, line format); the listener (waiter side) and the notifier (daemon side) are WaiterWakeListener.ts and WaiterNotifier.ts.
 */

/**
 * The longest unix socket path, in bytes, that is bound: `sun_path` holds 104 bytes on macOS and 108 on Linux, one of them the terminating NUL. The same limit is used on both,
 * so a config dir that works on Linux does not stop working on macOS.
 */
export const MAX_SOCKET_PATH_BYTES = 103;
/** A wake line is at most this long, newline included. */
export const WAKE_LINE_MAX_BYTES = 1024;

const MAX_WAKE_EVENT_CHARS = 300;
const MAX_WAKE_EVENT_ID_CHARS = 128;

export type WakeAddress =
  /** `privateDir`: the folder the socket is in must exist, be owned by the user and not be accessible to anyone else (mode 0700). Absent: the waiters folder. */
  | { kind: 'pipe'; path: string; privateDir?: string }
  /** No address: the wait polls only. `reason` says why and what to change. */
  | { kind: 'none'; reason: string };

export interface WakeDeriveDeps {
  platform?: NodeJS.Platform;
  tmpdir?: () => string;
  /** The user id for the private folder of the fallback (POSIX). Default: this process's. */
  uid?: number;
}

/** `<config dir>/waiters`, written the POSIX way whatever the host (the derivation is pure, and tested for both platforms everywhere). */
export function wakeSocketFolder(configDir: string): string {
  return posix.join(configKey(configDir, 'linux'), 'waiters');
}

function hash(text: string, chars: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, chars);
}

/**
 * The config dir as the daemon and the wait both write it: absolute, no trailing separator, and on Windows (case-insensitive) lower case with `/`.
 * Pure: no file system access, so the two processes agree whatever the current directory.
 */
function configKey(configDir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return win32.resolve(configDir).replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  }
  return posix.resolve(configDir).replace(/\/+$/, '');
}

/** The per-user folder of the short fallback paths (POSIX): `<tmpdir>/queue-wait-<uid>`. It must be owned by the user and closed to everyone else. */
export function wakePrivateDir(deps: WakeDeriveDeps = {}): string {
  return posix.join((deps.tmpdir ?? osTmpdir)().replaceAll('\\', '/'), `queue-wait-${deps.uid ?? process.getuid?.() ?? 'user'}`);
}

/**
 * Where the wait with this name listens. Windows: `\\.\pipe\queue-wait-<hash of the config dir>-<name>`. POSIX: `<config dir>/waiters/wake-<hash of the name>.sock`; when that is
 * longer than {@link MAX_SOCKET_PATH_BYTES} (a deep config dir), `<tmpdir>/queue-wait-<uid>/<hash of the config dir>-<hash of the name>.sock` in a private folder; when even that is too
 * long, no wake. The hash replaces the name in a file name because the longest name alone is 64 characters.
 */
export function deriveWakeAddress(configDir: string, name: string, deps: WakeDeriveDeps = {}): WakeAddress {
  const problem = waiterNameProblem(name);
  if (problem !== undefined) {
    return { kind: 'none', reason: `no wake address for an invalid wait name: ${problem}` };
  }
  const platform = deps.platform ?? process.platform;
  const key = configKey(configDir, platform);
  if (platform === 'win32') {
    return { kind: 'pipe', path: `\\\\.\\pipe\\queue-wait-${hash(key, 12)}-${name}` };
  }
  const primary = posix.join(wakeSocketFolder(configDir), `wake-${hash(name, 16)}.sock`);
  if (Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) {
    return { kind: 'pipe', path: primary };
  }
  const privateDir = wakePrivateDir(deps);
  const fallback = posix.join(privateDir, `${hash(key, 8)}-${hash(name, 10)}.sock`);
  if (Buffer.byteLength(fallback) <= MAX_SOCKET_PATH_BYTES) {
    return { kind: 'pipe', path: fallback, privateDir };
  }
  return {
    kind: 'none',
    reason: `the config dir path is too long for a unix socket (${Buffer.byteLength(primary)} bytes, the limit is ${MAX_SOCKET_PATH_BYTES}) and so is the temp dir (${Buffer.byteLength(fallback)} bytes). The wait still works by polling the history. Fix: use a shorter QUEUE_CONFIG_DIR or TMPDIR`,
  };
}

export interface WakeHint {
  event: string;
  eventId: string;
}

/** One line: `{"wake":1,"event":...,"eventId":...}` and a newline. Long values are cut: a hint is not a record. */
export function encodeWake(hint: WakeHint): string {
  return `${JSON.stringify({ wake: 1, event: hint.event.slice(0, MAX_WAKE_EVENT_CHARS), eventId: hint.eventId.slice(0, MAX_WAKE_EVENT_ID_CHARS) })}\n`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The hint in one line (without its newline), or undefined when the line is not exactly a wake line: any other shape is ignored by the wait. */
export function parseWake(line: string): WakeHint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields).sort();
  if (keys.length !== 3 || keys[0] !== 'event' || keys[1] !== 'eventId' || keys[2] !== 'wake' || fields['wake'] !== 1) {
    return undefined;
  }
  const { event, eventId } = fields;
  if (typeof event !== 'string' || typeof eventId !== 'string' || event === '' || eventId === '') {
    return undefined;
  }
  if (event.length > MAX_WAKE_EVENT_CHARS || eventId.length > MAX_WAKE_EVENT_ID_CHARS || CONTROL.test(event) || CONTROL.test(eventId)) {
    return undefined;
  }
  return { event, eventId };
}
