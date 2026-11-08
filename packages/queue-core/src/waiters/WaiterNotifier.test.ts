import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWaiterNotifier, sendWakeLine, type WakeSender } from './WaiterNotifier.js';
import { deriveWakeAddress, parseWake, type WakeHint } from './WaiterWake.js';
import { openWakeListener, type WakeListener } from './WaiterWakeListener.js';
import type { WaiterContact } from './WaiterRecord.js';

const LINUX = { platform: 'linux' as const, uid: 1000 };
const CONFIG = '/home/me/.config/queue';
const HINT: WakeHint = { event: 'onTaskDone', eventId: 'evt-1' };

function pipeOf(name: string, deps = LINUX): WaiterContact {
  const a = deriveWakeAddress(CONFIG, name, deps);
  if (a.kind !== 'pipe') throw new Error('no address');
  return { kind: 'pipe', path: a.path };
}

interface Harness {
  sent: Array<{ path: string; line: string }>;
  problems: Array<{ cause: string; message: string }>;
  notifier: ReturnType<typeof createWaiterNotifier>;
}

function harness(send?: WakeSender, extra: { maxWakes?: number } = {}): Harness {
  const sent: Harness['sent'] = [];
  const problems: Harness['problems'] = [];
  const notifier = createWaiterNotifier(CONFIG, {
    ...LINUX,
    send: send ?? (async (path, line) => { sent.push({ path, line }); }),
    onProblem: (cause, message) => { problems.push({ cause, message }); },
    ...extra,
  });
  return { sent, problems, notifier };
}

describe('createWaiterNotifier (injected sender)', () => {
  it('sends one wake line to the address it derived, and the line holds the event name and id only', () => {
    const h = harness();
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }], HINT);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.path).toBe((pipeOf('a.one') as { path: string }).path);
    expect(parseWake(h.sent[0]!.line.trimEnd())).toEqual(HINT);
    expect(Object.keys(JSON.parse(h.sent[0]!.line) as object).sort()).toEqual(['event', 'eventId', 'wake']);
  });

  it('wakes each matching wait with a pipe and skips the ones that only poll', () => {
    const h = harness();
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }, { name: 'b.two', contact: { kind: 'none' } }, { name: 'c.three', contact: pipeOf('c.three') }], HINT);
    // A wait that polls only is not an error: nothing is said about it
    expect(h.problems).toEqual([]);
    expect(h.sent.map((s) => s.path)).toEqual([(pipeOf('a.one') as { path: string }).path, (pipeOf('c.three') as { path: string }).path]);
  });

  it('NEVER connects to an address read from a record: a path that is not the derived one is refused and said once, however many pushes', () => {
    const h = harness();
    const forged: WaiterContact = { kind: 'pipe', path: '/tmp/somebody-elses.sock' };
    for (let i = 0; i < 3; i++) {
      h.notifier.notify([{ name: 'a.one', contact: forged }], HINT);
    }
    expect(h.sent).toEqual([]);
    expect(h.problems).toHaveLength(1);
    expect(h.problems[0]!.message).toContain('a.one');
    expect(h.problems[0]!.message).toContain('/tmp/somebody-elses.sock');
    expect(h.problems[0]!.message).toMatch(/not the address derived|differs from/);
  });

  it('a record whose name cannot be derived into an address is refused too (nothing is built from an invalid name)', () => {
    const h = harness();
    h.notifier.notify([{ name: '../evil', contact: { kind: 'pipe', path: '/tmp/x.sock' } }], HINT);
    expect(h.sent).toEqual([]);
    expect(h.problems).toHaveLength(1);
  });

  it('a record with the derived path of ANOTHER name is refused (the path belongs to a different wait)', () => {
    const h = harness();
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('b.two') }], HINT);
    expect(h.sent).toEqual([]);
    expect(h.problems).toHaveLength(1);
  });

  it('does not wait for the pipes: notify returns at once even when a connection never answers', () => {
    const pending: Array<() => void> = [];
    const h = harness(() => new Promise<void>((resolve) => { pending.push(resolve); }));
    const returned = h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }, { name: 'b.two', contact: pipeOf('b.two') }], HINT);
    expect(returned).toBeUndefined();
    // Both connections were started, none finished, and the caller already has its answer
    expect(pending).toHaveLength(2);
  });

  it('a pipe that fails never throws into the caller; the cause is said once per cause, naming the first wait and that it still polls', async () => {
    const codes = ['ECONNREFUSED', 'ENOENT', 'ECONNREFUSED', 'ECONNREFUSED'];
    let call = 0;
    const h = harness(async () => { throw Object.assign(new Error(`connect ${codes[call++]}`), { code: codes[call - 1] }); });
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }, { name: 'b.two', contact: pipeOf('b.two') }, { name: 'c.three', contact: pipeOf('c.three') }], HINT);
    await h.notifier.settled();
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }], HINT);
    await h.notifier.settled();
    expect(h.problems.map((p) => p.cause).sort()).toEqual(['ECONNREFUSED', 'ENOENT']);
    expect(h.problems.find((p) => p.cause === 'ECONNREFUSED')!.message).toContain('a.one');
    expect(h.problems.find((p) => p.cause === 'ECONNREFUSED')!.message).toMatch(/still polls/);
  });

  it('a sender that throws before it returns a promise is contained', async () => {
    const h = harness(() => { throw new Error('boom'); });
    expect(() => h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }], HINT)).not.toThrow();
    await h.notifier.settled();
    expect(h.problems).toHaveLength(1);
  });

  it('a sender that throws at once does not stop the waits after it', () => {
    const sent: string[] = [];
    const h = harness((path) => { if (path === (pipeOf('a.one') as { path: string }).path) throw new Error('boom'); sent.push(path); return Promise.resolve(); });
    h.notifier.notify([{ name: 'a.one', contact: pipeOf('a.one') }, { name: 'b.two', contact: pipeOf('b.two') }], HINT);
    expect(sent).toEqual([(pipeOf('b.two') as { path: string }).path]);
  });

  it('wakes at most maxWakes waits of one push and says so once', () => {
    const h = harness(undefined, { maxWakes: 2 });
    const waiters = ['a.one', 'b.two', 'c.three', 'd.four'].map((name) => ({ name, contact: pipeOf(name) }));
    h.notifier.notify(waiters, HINT);
    h.notifier.notify(waiters, HINT);
    expect(h.sent).toHaveLength(4);
    expect(h.problems).toHaveLength(1);
    expect(h.problems[0]!.message).toMatch(/2 of 4/);
  });
});

describe('sendWakeLine: the connection, with an injected socket and timer', () => {
  class FakeSocket extends EventEmitter {
    destroyed = false;
    written: string[] = [];
    end(text: string, callback?: () => void): void { this.written.push(text); callback?.(); }
    destroy(): void { this.destroyed = true; }
  }
  const timers = () => {
    const pending = new Map<number, () => void>();
    let next = 1;
    return {
      pending,
      setTimer: (callback: () => void) => { const id = next++; pending.set(id, callback); return id as unknown as NodeJS.Timeout; },
      clearTimer: (id: NodeJS.Timeout) => { pending.delete(id as unknown as number); },
    };
  };

  it('writes the line once connected, then closes', async () => {
    const socket = new FakeSocket();
    const t = timers();
    const sent = sendWakeLine('/p', 'line\n', { createConnection: (() => { queueMicrotask(() => socket.emit('connect')); return socket; }) as unknown as typeof net.createConnection, ...t });
    await sent;
    expect(socket.written).toEqual(['line\n']);
    expect(socket.destroyed).toBe(true);
    expect(t.pending.size).toBe(0);
  });

  it('a connection that never completes is dropped when the timer fires, with a timeout error', async () => {
    const socket = new FakeSocket();
    const t = timers();
    const sent = sendWakeLine('/p', 'line\n', { createConnection: (() => socket) as unknown as typeof net.createConnection, ...t });
    expect(t.pending.size).toBe(1);
    [...t.pending.values()][0]!();
    await expect(sent).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(socket.destroyed).toBe(true);
  });

  it('a refused connection rejects with its code', async () => {
    const socket = new FakeSocket();
    const sent = sendWakeLine('/p', 'line\n', { createConnection: (() => { queueMicrotask(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))); return socket; }) as unknown as typeof net.createConnection, ...timers() });
    await expect(sent).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(socket.destroyed).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin')('daemon to wait over a real pipe', () => {
  let configDir: string;
  let listener: WakeListener | undefined;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'wn-'));
  });
  afterEach(() => {
    listener?.close();
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('the wait hears the wake the notifier sends, with the real sender', async () => {
    const heard = new Promise<WakeHint>((resolve) => {
      void openWakeListener(configDir, 'a.real', resolve).then((opened) => {
        listener = opened;
        const problems: string[] = [];
        const notifier = createWaiterNotifier(configDir, { onProblem: (_cause, message) => { problems.push(message); } });
        notifier.notify([{ name: 'a.real', contact: opened.contact }], HINT);
        void notifier.settled().then(() => { if (problems.length > 0) throw new Error(problems.join('; ')); });
      });
    });
    expect(await heard).toEqual(HINT);
  });
});
