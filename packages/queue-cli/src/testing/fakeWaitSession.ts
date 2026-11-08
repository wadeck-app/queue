// Test helper: the outside of a registered wait (heartbeat timer, signals, exit event, process exit, stderr) as recorders, so a test drives each by hand and nothing sleeps
// or sends a real signal.
import type { WaitSessionDeps } from '../cli/waitSession.js';

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
}

export function fakeWaitSession(registry: WaitSessionDeps['registry']): FakeWaitSession {
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
  };
  return fake;
}
