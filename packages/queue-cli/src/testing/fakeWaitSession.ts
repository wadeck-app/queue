// Test helper: the outside of a registered wait (heartbeat timer, signals, exit event, process exit, stderr, the wake pipe) as recorders, so a test drives each by hand and nothing
// sleeps or sends a real signal.
import type { WakeHint, WakeListener, WaiterContact } from '@wadeck-app/queue-core';
import type { WaitSessionDeps } from '../cli/waitSession.js';

export interface FakeWakeOptions {
  /** What the pipe says it listens on. Default: a pipe called after the name. */
  contact?: WaiterContact;
  /** A pipe that could not be opened: no contact, this sentence. */
  warning?: string;
  /** Opening the pipe throws this (a bug, an unexpected error). */
  throws?: Error;
  /** The sweep of the left-over sockets fails with this. */
  sweepThrows?: Error;
}

export interface FakeWaitSession {
  deps: WaitSessionDeps;
  stderr: string[];
  /** The heartbeat callbacks that were started, in order; call one to make a heartbeat happen. */
  ticks: Array<() => void>;
  timerPeriods: number[];
  stoppedTimers: () => number;
  signalHandlers: Map<string, (signal: NodeJS.Signals) => void>;
  exitHandlers: Array<() => void>;
  disposedSignals: () => number;
  disposedExit: () => number;
  /** The codes `deps.exit` was called with (the process does not really exit). */
  exits: number[];
  /** What happened to the wake pipe, in order: 'sweep', 'open <name>', 'close'. */
  wakeCalls: string[];
  /** The `onWake` handlers given to the pipe; call one to make the daemon wake the wait. */
  wakeHandlers: Array<(hint: WakeHint) => void>;
}

export function fakeWaitSession(registry: WaitSessionDeps['registry'], wake?: FakeWakeOptions): FakeWaitSession {
  let stopped = 0;
  let signalsDisposed = 0;
  let exitDisposed = 0;
  const fake: FakeWaitSession = {
    stderr: [],
    ticks: [],
    timerPeriods: [],
    stoppedTimers: () => stopped,
    signalHandlers: new Map(),
    exitHandlers: [],
    disposedSignals: () => signalsDisposed,
    disposedExit: () => exitDisposed,
    exits: [],
    wakeCalls: [],
    wakeHandlers: [],
    deps: undefined as never,
  };
  fake.deps = {
    registry,
    stderr: { write: (text) => { fake.stderr.push(text); } },
    startTimer: (tick, ms) => {
      fake.ticks.push(tick);
      fake.timerPeriods.push(ms);
      return () => { stopped++; };
    },
    onSignals: (signals, handler) => {
      for (const signal of signals) fake.signalHandlers.set(signal, handler);
      return () => { signalsDisposed++; };
    },
    onExit: (handler) => {
      fake.exitHandlers.push(handler);
      return () => { exitDisposed++; };
    },
    exit: (code) => { fake.exits.push(code); },
    ...(wake !== undefined && {
      sweepWake: async () => {
        fake.wakeCalls.push('sweep');
        if (wake.sweepThrows !== undefined) throw wake.sweepThrows;
      },
      openWake: async (name: string, onWake: (hint: WakeHint) => void): Promise<WakeListener> => {
        fake.wakeCalls.push(`open ${name}`);
        if (wake.throws !== undefined) throw wake.throws;
        fake.wakeHandlers.push(onWake);
        const contact: WaiterContact = wake.warning !== undefined ? { kind: 'none' } : (wake.contact ?? { kind: 'pipe', path: `/fake/wake-${name}.sock` });
        return { contact, ...(wake.warning !== undefined && { warning: wake.warning }), close: () => { fake.wakeCalls.push('close'); } };
      },
    }),
  };
  return fake;
}
