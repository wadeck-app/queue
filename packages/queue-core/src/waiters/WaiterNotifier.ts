import * as net from 'node:net';
import { deriveWakeAddress, encodeWake, type WakeDeriveDeps, type WakeHint } from './WaiterWake.js';
import type { WaiterContact } from './WaiterRecord.js';
import { errorCode, errorText } from './WaiterLiveness.js';

/** The daemon's side of the wake: after the history record of a push it tells each matching wait with a pipe to look at the history. Fire and forget, a hint only (see WaiterWake.ts). */

/** A connection that has not completed within this is dropped. */
export const WAKE_CONNECT_TIMEOUT_MS = 1000;
/** One push wakes at most this many waits. */
export const MAX_WAKES_PER_PUSH = 50;

/** Connects to `path`, writes `line`, closes. Rejects (with the error code when there is one) when it cannot, and with `ETIMEDOUT` when it takes too long. */
export type WakeSender = (path: string, line: string) => Promise<void>;

export interface SendWakeDeps {
  createConnection?: typeof net.createConnection;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  timeoutMs?: number;
}

export function sendWakeLine(path: string, line: string, deps: SendWakeDeps = {}): Promise<void> {
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms).unref());
  const clearTimer = deps.clearTimer ?? clearTimeout;
  return new Promise<void>((resolve, reject) => {
    const socket = (deps.createConnection ?? net.createConnection)({ path });
    let settled = false;
    const timer = setTimer(() => { done(Object.assign(new Error(`no connection within ${deps.timeoutMs ?? WAKE_CONNECT_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' })); }, deps.timeoutMs ?? WAKE_CONNECT_TIMEOUT_MS);
    const done = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timer);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once('error', (error) => { done(error); });
    socket.once('connect', () => { socket.end(line, () => { done(); }); });
  });
}

export interface WaiterNotifierDeps extends WakeDeriveDeps {
  /** Default: {@link sendWakeLine}. */
  send?: WakeSender;
  /** A wake that could not be sent or a record that was refused: `cause` is the key the caller says once (an error code, or a refusal), `message` the sentence. */
  onProblem: (cause: string, message: string) => void;
  /** Default {@link MAX_WAKES_PER_PUSH}. */
  maxWakes?: number;
}

export interface WaiterNotifier {
  /**
   * Starts a wake for each of the waits that has a pipe. Returns at once and never throws: the connections run on their own, and what goes wrong is reported through `onProblem`
   * (once per cause). The address is recomputed from the name and the config dir; a record whose contact says another path is refused.
   */
  notify: (waiters: ReadonlyArray<{ name: string; contact: WaiterContact }>, hint: WakeHint) => void;
  /** Resolves when every wake started so far has ended (tests, and a daemon that shuts down). */
  settled: () => Promise<void>;
}

export function createWaiterNotifier(configDir: string, deps: WaiterNotifierDeps): WaiterNotifier {
  const send = deps.send ?? ((path: string, line: string) => sendWakeLine(path, line));
  const maxWakes = deps.maxWakes ?? MAX_WAKES_PER_PUSH;
  const said = new Set<string>();
  const inflight = new Set<Promise<void>>();

  const sayOnce = (cause: string, message: string): void => {
    if (!said.has(cause)) {
      said.add(cause);
      try {
        deps.onProblem(cause, message);
      } catch {
        // The report of a problem never breaks the push
      }
    }
  };

  return {
    notify(waiters, hint) {
      try {
        const line = encodeWake(hint);
        const withPipe = waiters.filter((waiter) => waiter.contact.kind === 'pipe');
        if (withPipe.length > maxWakes) {
          sayOnce('too-many', `${withPipe.length} waits listen for a wake; only ${maxWakes} are woken per push, the others find the event at their next poll. Woke ${maxWakes} of ${withPipe.length}.`);
        }
        for (const waiter of withPipe.slice(0, maxWakes)) {
          const claimed = waiter.contact.kind === 'pipe' ? waiter.contact.path : '';
          const derived = deriveWakeAddress(configDir, waiter.name, deps);
          if (derived.kind !== 'pipe' || derived.path !== claimed) {
            sayOnce(`refused:${waiter.name}:${claimed}`, `the record of the wait '${waiter.name}' says it listens on ${JSON.stringify(claimed)}, which is not the address derived from its name (${derived.kind === 'pipe' ? derived.path : derived.reason}): it was NOT woken and nothing was connected to. It still polls the history. Fix: restart that wait (it writes its own record); if you did not expect a record to be edited, treat the waiters folder as untrusted.`);
            continue;
          }
          let attempt: Promise<void>;
          try {
            attempt = Promise.resolve(send(derived.path, line));
          } catch (error) {
            attempt = Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          const tracked: Promise<void> = attempt.catch((error: unknown) => {
            const code = errorCode(error) ?? 'error';
            sayOnce(code, `could not wake the wait '${waiter.name}' on ${derived.path} (${code}: ${errorText(error)}); it still polls the history, so it finds the event at its next poll. This is said once per cause per daemon run.`);
          }).finally(() => { inflight.delete(tracked); });
          inflight.add(tracked);
        }
      } catch (error) {
        sayOnce('notify', `could not start the wakes of a push (${errorText(error)}); the waits still poll the history. The push is not affected.`);
      }
    },
    settled: async () => {
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },
  };
}
