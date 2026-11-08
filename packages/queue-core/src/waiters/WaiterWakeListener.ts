import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import * as net from 'node:net';
import { posix } from 'node:path';
import { WAKE_LINE_MAX_BYTES, deriveWakeAddress, parseWake, wakePrivateDir, wakeSocketFolder, type WakeAddress, type WakeDeriveDeps, type WakeHint } from './WaiterWake.js';
import type { WaiterContact } from './WaiterRecord.js';
import { errorCode, errorText } from './WaiterLiveness.js';

/** The wait's side of the wake: it listens on its derived pipe or socket and tells its owner when a well-formed wake line arrives. A hint only, see WaiterWake.ts. */

/** At most this many wake connections are served at once; a local flood cannot hold more. */
const MAX_WAKE_CONNECTIONS = 8;
/** A connection that sends no complete line within this is dropped (a hang guard, not a limit anyone is expected to meet). */
const CONNECTION_IDLE_MS = 2000;

/** The slice of the file system the listener and the sweep use, replaceable in tests. */
export interface WakeFs {
  mkdir: (path: string, mode: number) => void;
  lstat: (path: string) => Pick<Stats, 'isSocket' | 'isDirectory' | 'isSymbolicLink' | 'mode' | 'uid'>;
  unlink: (path: string) => void;
  chmod: (path: string, mode: number) => void;
  readdir: (path: string) => string[];
}

export const defaultWakeFs: WakeFs = {
  mkdir: (path, mode) => { mkdirSync(path, { recursive: true, mode }); },
  lstat: (path) => lstatSync(path),
  unlink: (path) => { unlinkSync(path); },
  chmod: (path, mode) => { chmodSync(path, mode); },
  readdir: (path) => readdirSync(path),
};

/** What a connection to a socket path found: someone listens, nobody does (the file is left over), the path does not exist, or it could not be told. */
export type ProbeResult = 'live' | 'refused' | 'missing' | 'unknown';

export interface WakeListenerDeps extends WakeDeriveDeps {
  fs?: Partial<WakeFs>;
  /** Replaces the connection that tells whether a socket file has an owner. */
  probe?: (path: string) => Promise<ProbeResult>;
  /** Replaces `net.createServer` (tests inject a server that fails). */
  createServer?: typeof net.createServer;
  /** Default: this process's. POSIX only. */
  getuid?: () => number | undefined;
  /** Called for every connection whose line was not a wake line (a counter in tests; ignored otherwise). */
  onIgnored?: (why: string) => void;
  umask?: (mask: number) => number;
}

export interface WakeListener {
  /** What the record carries: the pipe, or `none` when listening was not possible. */
  contact: WaiterContact;
  /** Why there is no wake, as one sentence that says what to change; absent when listening. */
  warning?: string;
  /** Stops listening and removes the socket file. Never throws, can be called twice. */
  close: () => void;
}

/** Connects to a socket path and drops the connection at once: refused = a left-over file nobody listens on. */
export function probeWakeSocket(path: string, createConnection: typeof net.createConnection = net.createConnection): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (result: ProbeResult): void => {
      socket.destroy();
      resolve(result);
    };
    // Backlog full or hung owner: someone is there
    socket.setTimeout(1000, () => { done('live'); });
    socket.once('connect', () => { done('live'); });
    socket.once('error', (error) => {
      const code = errorCode(error);
      done(code === 'ECONNREFUSED' ? 'refused' : code === 'ENOENT' ? 'missing' : 'unknown');
    });
  });
}

function none(reason: string): WakeListener {
  return { contact: { kind: 'none' }, warning: reason, close: () => undefined };
}

function ignoringMissing(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Makes sure the folder that holds the socket cannot be used by others to plant or replace a socket: it is a real folder (not a link), owned by this user, and not writable by group
 * or others. A folder this user owns whose group/other write bit is set (umask 002 on many Linux systems) is tightened; any other problem is returned as the reason.
 */
function folderProblem(path: string, uid: number | undefined, fs: WakeFs, privateFolder: boolean): string | undefined {
  try {
    const stat = fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return `${path} is not a plain folder`;
    }
    if (uid !== undefined && stat.uid !== uid) {
      return `${path} is owned by another user`;
    }
    const openBits = privateFolder ? 0o077 : 0o022;
    if ((stat.mode & openBits) !== 0) {
      fs.chmod(path, stat.mode & 0o7777 & ~openBits);
      if ((fs.lstat(path).mode & openBits) !== 0) {
        return `${path} can be written by other users and could not be tightened`;
      }
    }
    return undefined;
  } catch (error) {
    return `${path} cannot be checked (${errorText(error)})`;
  }
}

/** What a socket path holds: nothing, a socket this user owns, or something else (which is never touched). */
function socketKind(path: string, uid: number | undefined, fs: WakeFs): 'absent' | 'socket' | 'other' {
  try {
    const stat = fs.lstat(path);
    return stat.isSocket() && (uid === undefined || stat.uid === uid) ? 'socket' : 'other';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return 'absent';
    }
    return 'other';
  }
}

/**
 * Opens the wake pipe of the wait called `name`. `onWake` is called for each well-formed wake line, nothing else. Never throws: when listening is not possible (the name is
 * invalid, the path is too long, another wait holds the address, the folder is not safe, the system refuses) the result has `contact: none` and a `warning`, and the wait
 * polls only. Call it BEFORE registering, so the record carries the contact; call `close` on every way out.
 *
 * POSIX: the socket is created with mode 0600 in a folder that only this user can write. A socket file left by a dead owner is removed (a connection to it is refused); one with a live
 * owner is never touched (this wait gets no wake). Windows: a pipe vanishes with its owner.
 */
export async function openWakeListener(configDir: string, name: string, onWake: (hint: WakeHint) => void, deps: WakeListenerDeps = {}): Promise<WakeListener> {
  const platform = deps.platform ?? process.platform;
  const address: WakeAddress = deriveWakeAddress(configDir, name, deps);
  if (address.kind === 'none') {
    return none(address.reason);
  }
  const fs: WakeFs = { ...defaultWakeFs, ...deps.fs };
  const posixSocket = platform !== 'win32';
  const uid = posixSocket ? (deps.getuid ?? process.getuid?.bind(process))?.() : undefined;

  if (posixSocket) {
    const folder = address.privateDir ?? wakeSocketFolder(configDir);
    try {
      fs.mkdir(folder, address.privateDir === undefined ? 0o777 : 0o700);
    } catch (error) {
      return none(`could not create ${folder} (${errorText(error)}); polling the history only`);
    }
    const problem = folderProblem(folder, uid, fs, address.privateDir !== undefined);
    if (problem !== undefined) {
      return none(`${problem}, so no wake socket is created there (anyone who can write the folder could plant a socket); polling the history only`);
    }
    const kind = socketKind(address.path, uid, fs);
    if (kind === 'other') {
      return none(`${address.path} exists and is not a socket of this user; polling the history only. Fix: delete it`);
    }
    if (kind === 'socket') {
      const probed = await (deps.probe ?? ((path: string) => probeWakeSocket(path)))(address.path);
      if (probed !== 'refused' && probed !== 'missing') {
        return none(`${address.path} is used by a live process (EADDRINUSE): another wait holds this name or the socket is busy; polling the history only`);
      }
      try {
        ignoringMissing(() => { fs.unlink(address.path); });
      } catch (error) {
        return none(`could not remove the left-over socket ${address.path} (${errorText(error)}); polling the history only`);
      }
    }
  }

  const sockets = new Set<net.Socket>();
  const server = (deps.createServer ?? net.createServer)();
  server.maxConnections = MAX_WAKE_CONNECTIONS;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); });
    socket.on('error', () => { socket.destroy(); });
    socket.setTimeout(CONNECTION_IDLE_MS, () => { socket.destroy(); });
    socket.setEncoding('utf8');
    let buffered = '';
    let decided = false;
    const ignore = (why: string): void => {
      decided = true;
      deps.onIgnored?.(why);
      socket.destroy();
    };
    socket.on('data', (chunk: string) => {
      if (decided) {
        return;
      }
      buffered += chunk;
      if (Buffer.byteLength(buffered) > WAKE_LINE_MAX_BYTES) {
        ignore('too long');
        return;
      }
      const end = buffered.indexOf('\n');
      if (end === -1) {
        return;
      }
      const hint = parseWake(buffered.slice(0, end));
      if (hint === undefined) {
        ignore('not a wake line');
        return;
      }
      decided = true;
      socket.end();
      try {
        onWake(hint);
      } catch {
        // The owner's handler is a hint: it never breaks the listener
      }
    });
    socket.on('end', () => {
      if (!decided) {
        ignore('closed without a line');
      }
    });
  });

  const umask = deps.umask ?? (posixSocket ? process.umask.bind(process) : undefined);
  const previousMask = umask?.(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    return none(`could not listen on ${address.path} (${errorCode(error) ?? errorText(error)}: ${errorText(error)}); polling the history only`);
  } finally {
    if (previousMask !== undefined) {
      umask?.(previousMask);
    }
  }
  server.on('error', () => undefined);

  const dispose = (): void => {
    for (const socket of sockets) socket.destroy();
    server.close();
    if (posixSocket) {
      try {
        ignoringMissing(() => { fs.unlink(address.path); });
      } catch {
        // A left-over file is swept by the next wait that registers
      }
    }
  };
  if (posixSocket) {
    try {
      fs.chmod(address.path, 0o600);
    } catch (error) {
      dispose();
      return none(`could not restrict ${address.path} to this user (${errorText(error)}); polling the history only`);
    }
  }
  // The wait itself keeps the process alive; the listener must not
  server.unref();

  let closed = false;
  return {
    contact: { kind: 'pipe', path: address.path },
    close: () => {
      if (!closed) {
        closed = true;
        dispose();
      }
    },
  };
}

const PRIMARY_SOCKET = /^wake-[0-9a-f]{16}\.sock$/;
const FALLBACK_SOCKET = /^[0-9a-f]{8}-[0-9a-f]{10}\.sock$/;

/**
 * POSIX: removes the wake sockets in the waiters folder (and in the private temp folder of the fallback) whose owner is gone: a socket of this user that a connection finds refused.
 * Called by a wait before it registers. Only files named like a wake socket are looked at; a live one answers the connection and stays. Returns the paths removed. Never throws.
 */
export async function sweepStaleWakeSockets(configDir: string, deps: WakeListenerDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    return [];
  }
  const fs: WakeFs = { ...defaultWakeFs, ...deps.fs };
  const uid = (deps.getuid ?? process.getuid?.bind(process))?.();
  const folders: Array<[string, RegExp]> = [[wakeSocketFolder(configDir), PRIMARY_SOCKET]];
  folders.push([wakePrivateDir({ ...deps, ...(uid !== undefined && { uid }) }), FALLBACK_SOCKET]);
  const removed: string[] = [];
  for (const [folder, pattern] of folders) {
    let names: string[];
    try {
      names = fs.readdir(folder).filter((entry) => pattern.test(entry));
    } catch {
      continue;
    }
    for (const entry of names) {
      const path = posix.join(folder, entry);
      try {
        if (socketKind(path, uid, fs) !== 'socket') {
          continue;
        }
        const probed = await (deps.probe ?? ((target: string) => probeWakeSocket(target)))(path);
        if (probed === 'refused') {
          fs.unlink(path);
          removed.push(path);
        }
      } catch {
        // Not ours to fix: a wait only sweeps what it can
      }
    }
  }
  return removed;
}
