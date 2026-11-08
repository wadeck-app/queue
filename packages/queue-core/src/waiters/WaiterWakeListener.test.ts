import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWake, deriveWakeAddress, type WakeHint } from './WaiterWake.js';
import { openWakeListener, sweepStaleWakeSockets, type ProbeResult, type WakeFs, type WakeListener, type WakeListenerDeps } from './WaiterWakeListener.js';
import { waitersDir } from './WaiterHistory.js';

// A real pipe (Windows) or unix socket (POSIX) round trip on the platform the tests run on. The logic around it (folder checks, stale files, failures) is tested with an injected
// file system and server further down, so it runs on every platform.

const REAL_SUPPORTED = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin';

/** Sends bytes to a pipe and resolves when the other side has closed the connection (it has made up its mind about the line). */
function send(path: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    socket.once('error', reject);
    socket.once('close', () => { resolve(); });
    socket.once('connect', () => { socket.end(text); });
  });
}

function connectError(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path });
    socket.once('error', (error) => { resolve((error as NodeJS.ErrnoException).code); });
    socket.once('connect', () => { socket.destroy(); resolve(undefined); });
  });
}

describe.skipIf(!REAL_SUPPORTED)('a real wake pipe on this platform', () => {
  let configDir: string;
  const open: WakeListener[] = [];
  beforeEach(() => {
    // Short: a unix socket path is limited to about 100 bytes
    configDir = mkdtempSync(join(tmpdir(), 'wl-'));
  });
  afterEach(() => {
    for (const listener of open.splice(0)) listener.close();
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function listen(name: string, hints: WakeHint[], deps: WakeListenerDeps = {}): Promise<WakeListener> {
    const listener = await openWakeListener(configDir, name, (hint) => { hints.push(hint); }, deps);
    open.push(listener);
    return listener;
  }

  it('listens on the address derived from the config dir and the name, and says so in its contact', async () => {
    const listener = await listen('a.round', []);
    const derived = deriveWakeAddress(configDir, 'a.round');
    expect(derived.kind).toBe('pipe');
    expect(listener.contact).toEqual({ kind: 'pipe', path: derived.kind === 'pipe' ? derived.path : '' });
    expect(listener.warning).toBeUndefined();
  });

  it('delivers the event name and id of a wake line', async () => {
    const hints: WakeHint[] = [];
    const listener = await listen('a.round', hints);
    await send((listener.contact as { path: string }).path, encodeWake({ event: 'onTaskDone', eventId: 'evt-1' }));
    expect(hints).toEqual([{ event: 'onTaskDone', eventId: 'evt-1' }]);
  });

  it('ignores everything that is not a wake line: garbage, a payload, a line that is too long, an empty connection', async () => {
    const hints: WakeHint[] = [];
    const ignored: string[] = [];
    const listener = await listen('a.round', hints, { onIgnored: (why) => { ignored.push(why); } });
    const path = (listener.contact as { path: string }).path;
    await send(path, 'GET / HTTP/1.1\r\n\r\n');
    await send(path, '{"wake":1,"event":"a","eventId":"b","payload":{"secret":1}}\n');
    await send(path, 'x'.repeat(5000));
    await send(path, '');
    expect(hints).toEqual([]);
    expect(ignored).toHaveLength(4);
    // The oversized one is dropped for its size, before it is buffered whole
    expect(ignored).toContain('too long');
    // Still serving
    await send(path, encodeWake({ event: 'onX', eventId: 'e2' }));
    expect(hints).toEqual([{ event: 'onX', eventId: 'e2' }]);
  });

  it('close() stops listening and removes the socket file; a second close is harmless', async () => {
    const listener = await listen('a.round', []);
    const path = (listener.contact as { path: string }).path;
    listener.close();
    listener.close();
    expect(await connectError(path)).toBeDefined();
    if (process.platform !== 'win32') {
      expect(existsSync(path)).toBe(false);
    }
  });

  it('a second wait with the same name gets no wake (the address is taken), says why, and does not disturb the first', async () => {
    const hints: WakeHint[] = [];
    const first = await listen('a.round', hints);
    const second = await listen('a.round', []);
    expect(second.contact).toEqual({ kind: 'none' });
    expect(second.warning).toMatch(/EADDRINUSE|already|in use|could not listen/i);
    second.close();
    await send((first.contact as { path: string }).path, encodeWake({ event: 'onX', eventId: 'e1' }));
    expect(hints).toHaveLength(1);
  });

  // A crashed wait leaves its socket file. POSIX only (a Windows pipe vanishes with its owner); the owner is a real process killed with SIGKILL
  it.skipIf(process.platform === 'win32')('a socket file left by a killed owner is swept by the next wait, and a wait with the same name listens in its place', async () => {
    const address = deriveWakeAddress(configDir, 'a.round');
    if (address.kind !== 'pipe') throw new Error('no address for the test');
    mkdirSync(join(configDir, 'waiters'), { recursive: true });
    const owner = spawn(process.execPath, [fileURLToPath(new URL('./wakeSocketOwner.testUtil.mjs', import.meta.url)), address.path], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      owner.once('error', reject);
      owner.stdout.once('data', () => { resolve(); });
    });
    const exited = new Promise<void>((resolve) => { owner.once('exit', () => { resolve(); }); });
    owner.kill('SIGKILL');
    await exited;
    expect(existsSync(address.path)).toBe(true);
    expect(await connectError(address.path)).toBe('ECONNREFUSED');

    expect(await sweepStaleWakeSockets(configDir)).toEqual([address.path]);
    expect(existsSync(address.path)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('the socket file is for this user only (mode 0600) and its folder is not writable by group or others', async () => {
    const listener = await listen('a.round', []);
    const path = (listener.contact as { path: string }).path;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(waitersDir(configDir)).mode & 0o022).toBe(0);
  });
});

// ---- the logic around the socket, with an injected file system and server (every platform) ----

const LINUX = { platform: 'linux' as const, uid: 1000, getuid: () => 1000, umask: (mask: number) => (mask === 0o177 ? 0o022 : 0o177) };

interface FakeStat { kind: 'dir' | 'socket' | 'file' | 'link'; mode?: number; uid?: number }

function fakeFs(entries: Record<string, FakeStat>, calls: string[]): WakeFs {
  return {
    mkdir: (path, mode) => { calls.push(`mkdir ${path} ${mode.toString(8)}`); },
    lstat: (path) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {
        isSocket: () => entry.kind === 'socket',
        isDirectory: () => entry.kind === 'dir',
        isSymbolicLink: () => entry.kind === 'link',
        mode: entry.mode ?? (entry.kind === 'dir' ? 0o40755 : 0o140600),
        uid: entry.uid ?? 1000,
      };
    },
    unlink: (path) => { calls.push(`unlink ${path}`); delete entries[path]; },
    chmod: (path, mode) => {
      calls.push(`chmod ${path} ${mode.toString(8)}`);
      const entry = entries[path];
      if (entry !== undefined && entry.kind === 'dir') entries[path] = { ...entry, mode: 0o40000 | mode };
    },
    readdir: (path) => Object.keys(entries).filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map((p) => p.slice(path.length + 1)),
  };
}

class FakeServer extends EventEmitter {
  maxConnections = 0;
  listening = false;
  closed = false;
  constructor(private readonly failWith?: string) { super(); }
  listen(_path: string, callback: () => void): this {
    if (this.failWith !== undefined) {
      queueMicrotask(() => { this.emit('error', Object.assign(new Error(`listen ${this.failWith}`), { code: this.failWith })); });
    } else {
      this.listening = true;
      queueMicrotask(callback);
    }
    return this;
  }
  close(): this { this.closed = true; return this; }
  unref(): this { return this; }
}

describe('openWakeListener: what it checks before it listens (injected file system)', () => {
  const configDir = '/home/me/.config/queue';
  const waiters = '/home/me/.config/queue/waiters';
  const socketPath = (name: string): string => {
    const a = deriveWakeAddress(configDir, name, LINUX);
    if (a.kind !== 'pipe') throw new Error('no address');
    return a.path;
  };
  const server = (fail?: string): { create: () => net.Server; instance: FakeServer } => {
    const instance = new FakeServer(fail);
    return { create: () => instance as unknown as net.Server, instance };
  };

  it('an invalid name gets no pipe and touches nothing', async () => {
    const calls: string[] = [];
    const listener = await openWakeListener(configDir, 'nodot', () => undefined, { ...LINUX, fs: fakeFs({}, calls) });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/invalid wait name/);
    expect(calls).toEqual([]);
  });

  it('tightens a waiters folder that this user owns and that group or others can write, then listens', async () => {
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir', mode: 0o40775 } };
    const { create, instance } = server();
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, calls), createServer: create });
    expect(calls).toContain(`chmod ${waiters} 755`);
    expect(listener.contact.kind).toBe('pipe');
    expect(instance.listening).toBe(true);
  });

  it('refuses a folder that another user owns', async () => {
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir', uid: 0 } };
    const { create, instance } = server();
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, []), createServer: create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/owned by another user/);
    expect(instance.listening).toBe(false);
  });

  it('refuses a folder that is a link', async () => {
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'link' } };
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, []), createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/not a plain folder/);
  });

  it('refuses a folder it cannot make private, saying what it was tried', async () => {
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir', mode: 0o40777 } };
    const fs = fakeFs(entries, []);
    // chmod that does nothing (a file system without modes)
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: { ...fs, chmod: () => undefined }, createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/could not be tightened/);
  });

  it('never touches a file at the socket path that is not a socket of this user', async () => {
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' }, [socketPath('a.b')]: { kind: 'file' } };
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, calls), createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/not a socket of this user/);
    expect(calls.filter((c) => c.startsWith('unlink'))).toEqual([]);
  });

  it('removes a left-over socket nobody listens on, and listens', async () => {
    const calls: string[] = [];
    const path = socketPath('a.b');
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' }, [path]: { kind: 'socket' } };
    const { create, instance } = server();
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, calls), probe: async () => 'refused', createServer: create });
    expect(calls).toContain(`unlink ${path}`);
    expect(listener.contact).toEqual({ kind: 'pipe', path });
    expect(instance.listening).toBe(true);
  });

  it.each<ProbeResult>(['live', 'unknown'])('never removes a socket whose owner answers or cannot be told (%s): no wake for this wait', async (probed) => {
    const calls: string[] = [];
    const path = socketPath('a.b');
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' }, [path]: { kind: 'socket' } };
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, calls), probe: async () => probed, createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/EADDRINUSE/);
    expect(calls.filter((c) => c.startsWith('unlink'))).toEqual([]);
  });

  it('a listen failure is no wake and a sentence with the cause, never an exception; the server is closed', async () => {
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' } };
    const { create, instance } = server('EACCES');
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, fs: fakeFs(entries, []), createServer: create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/EACCES/);
    expect(instance.closed).toBe(true);
  });

  it('a socket it cannot restrict to its user is closed and unlisted', async () => {
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' } };
    const fs = fakeFs(entries, calls);
    const { create, instance } = server();
    const listener = await openWakeListener(configDir, 'a.b', () => undefined, {
      ...LINUX,
      fs: { ...fs, chmod: (path, mode) => { if (path.endsWith('.sock')) throw new Error('EPERM'); fs.chmod(path, mode); } },
      createServer: create,
    });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/restrict/);
    expect(instance.closed).toBe(true);
  });

  it('binds under a restrictive umask and puts the previous one back, also when listening fails', async () => {
    const masks: number[] = [];
    const umask = (mask: number): number => { masks.push(mask); return 0o022; };
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' } };
    await openWakeListener(configDir, 'a.b', () => undefined, { ...LINUX, umask, fs: fakeFs(entries, []), createServer: server('EACCES').create });
    expect(masks).toEqual([0o177, 0o022]);
  });

  it('uses a private 0700 folder under the temp dir when the config dir is too deep for a socket', async () => {
    const deep = '/' + 'd'.repeat(120);
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = { '/tmp/queue-wait-1000': { kind: 'dir', mode: 0o40700 } };
    const { create } = server();
    const listener = await openWakeListener(deep, 'a.b', () => undefined, { ...LINUX, tmpdir: () => '/tmp', fs: fakeFs(entries, calls), createServer: create });
    expect(calls[0]).toBe('mkdir /tmp/queue-wait-1000 700');
    expect(listener.contact.kind === 'pipe' && listener.contact.path).toMatch(/^\/tmp\/queue-wait-1000\//);
  });

  it('refuses a private folder that others can enter', async () => {
    const deep = '/' + 'd'.repeat(120);
    const fs = fakeFs({ '/tmp/queue-wait-1000': { kind: 'dir', mode: 0o40755 } }, []);
    const listener = await openWakeListener(deep, 'a.b', () => undefined, { ...LINUX, tmpdir: () => '/tmp', fs: { ...fs, chmod: () => undefined }, createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/could not be tightened/);
  });

  it('a config dir that is too deep even for the fallback gets no wake and a sentence naming TMPDIR and QUEUE_CONFIG_DIR', async () => {
    const listener = await openWakeListener('/' + 'd'.repeat(120), 'a.b', () => undefined, { ...LINUX, tmpdir: () => '/' + 't'.repeat(100), fs: fakeFs({}, []), createServer: server().create });
    expect(listener.contact).toEqual({ kind: 'none' });
    expect(listener.warning).toMatch(/TMPDIR/);
  });
});

describe('sweepStaleWakeSockets (injected file system)', () => {
  const configDir = '/home/me/.config/queue';
  const waiters = '/home/me/.config/queue/waiters';
  const mine = `${waiters}/wake-0123456789abcdef.sock`;
  const alive = `${waiters}/wake-fedcba9876543210.sock`;

  it('removes a socket whose owner is gone and keeps one that answers', async () => {
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' }, [mine]: { kind: 'socket' }, [alive]: { kind: 'socket' } };
    const removed = await sweepStaleWakeSockets(configDir, { ...LINUX, fs: fakeFs(entries, calls), probe: async (path) => (path === alive ? 'live' : 'refused') });
    expect(removed).toEqual([mine]);
    expect(calls).toEqual([`unlink ${mine}`]);
  });

  it('looks only at files named like a wake socket, and only at sockets', async () => {
    const calls: string[] = [];
    const entries: Record<string, FakeStat> = {
      [waiters]: { kind: 'dir' },
      [`${waiters}/waiter-a.b.json`]: { kind: 'file' },
      [`${waiters}/waiters.lock`]: { kind: 'file' },
      [`${waiters}/wake-0123456789abcdef.sock.tmp`]: { kind: 'socket' },
      [`${waiters}/wake-0123456789abcdee.sock`]: { kind: 'file' },
      [`${waiters}/wake-0123456789abcdec.sock`]: { kind: 'socket', uid: 0 },
    };
    const probed: string[] = [];
    const removed = await sweepStaleWakeSockets(configDir, { ...LINUX, fs: fakeFs(entries, calls), probe: async (path) => { probed.push(path); return 'refused'; } });
    expect(removed).toEqual([]);
    expect(probed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('sweeps the private temp folder of the fallback too', async () => {
    const stale = '/tmp/queue-wait-1000/01234567-0123456789.sock';
    const entries: Record<string, FakeStat> = { '/tmp/queue-wait-1000': { kind: 'dir' }, [stale]: { kind: 'socket' } };
    const removed = await sweepStaleWakeSockets(configDir, { ...LINUX, tmpdir: () => '/tmp', fs: fakeFs(entries, []), probe: async () => 'refused' });
    expect(removed).toEqual([stale]);
  });

  it('does nothing on Windows (a pipe vanishes with its owner) and does not throw on a missing folder', async () => {
    expect(await sweepStaleWakeSockets(configDir, { platform: 'win32' })).toEqual([]);
    expect(await sweepStaleWakeSockets(configDir, { ...LINUX, fs: fakeFs({}, []) })).toEqual([]);
  });

  it('a socket it cannot remove is skipped, not thrown', async () => {
    const entries: Record<string, FakeStat> = { [waiters]: { kind: 'dir' }, [mine]: { kind: 'socket' } };
    const fs = fakeFs(entries, []);
    const removed = await sweepStaleWakeSockets(configDir, { ...LINUX, fs: { ...fs, unlink: () => { throw new Error('EPERM'); } }, probe: async () => 'refused' });
    expect(removed).toEqual([]);
  });
});
