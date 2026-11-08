/**
 * The registration of a `queue wait` while it runs (event wait and CI wait alike): the wait is listed before it reads the history (so a push that races its start counts it),
 * a heartbeat keeps it listed, and it is removed with an `end` record on every way out the process controls: it matched, it timed out, it failed, a signal or an exit.
 * A wait that is killed hard (SIGKILL, power) cannot write its end: the next sweep records it as `lost`.
 * Everything that touches the outside (timers, signals, exit, stderr) comes in through {@link WaitSessionDeps}, so the tests run without sleeping or sending a signal.
 */

import { WAITER_HEARTBEAT_MS, WaiterInputError, WaiterNameTakenError, WaiterRegistry, getErrorMessage, type WaiterEnd, type WaiterInput } from '@wadeck-app/queue-core';

export interface WaitSessionDeps {
  registry: Pick<WaiterRegistry, 'register' | 'heartbeat' | 'deregister' | 'sweepStale'>;
  stderr: { write: (text: string) => unknown };
  /** Calls `tick` every `ms` until the returned function is called. */
  startTimer: (tick: () => void, ms: number) => () => void;
  /** Calls `handler` when one of the signals arrives, until the returned function is called. */
  onSignals: (signals: readonly NodeJS.Signals[], handler: (signal: NodeJS.Signals) => void) => () => void;
  /** Calls `handler` (synchronously) when the process is about to exit, until the returned function is called. */
  onExit: (handler: () => void) => () => void;
  exit: (code: number) => void;
}

export function defaultWaitSessionDeps(configDir: string): WaitSessionDeps {
  return {
    registry: new WaiterRegistry(configDir),
    stderr: process.stderr,
    startTimer: (tick, ms) => {
      const timer = setInterval(tick, ms);
      // The wait itself keeps the process alive; the heartbeat must not
      timer.unref();
      return () => { clearInterval(timer); };
    },
    onSignals: (signals, handler) => {
      const bound = signals.map((signal) => [signal, () => { handler(signal); }] as const);
      for (const [signal, listener] of bound) process.on(signal, listener);
      return () => { for (const [signal, listener] of bound) process.off(signal, listener); };
    },
    onExit: (handler) => {
      process.on('exit', handler);
      return () => { process.off('exit', handler); };
    },
    exit: (code) => process.exit(code),
  };
}

/** The shell convention: 128 + the signal number. */
const SIGNAL_EXIT_CODES: ReadonlyArray<readonly [NodeJS.Signals, number]> = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]];

export const ANONYMOUS_PREFIX = 'anon.';

/** The name of a wait that was not given one (`--name` is optional for now): `anon.<pid>`. */
export function anonymousWaitName(name: string | undefined, pid: number): string {
  return name ?? `${ANONYMOUS_PREFIX}${pid}`;
}

export function isAnonymousWaitName(name: string): boolean {
  return name.startsWith(ANONYMOUS_PREFIX);
}

/** The one warning of a wait without `--name`. `command` is what to type, e.g. `queue wait onX` or `queue wait ci`. */
export function anonymousNameWarning(name: string, command: string): string {
  return `[warn] no --name: registered as ${name}. A name will become mandatory in a coming release, so that 'queue push' and 'queue waiters' can say who waits. Example: ${command} --name w-agent-wake.ab12cd34\n`;
}

/** How an event wait's exit code is recorded: 0 matched, 2 timeout; a usage error (4) after the registration is a wait that never really started. */
export function eventOutcomeOf(exitCode: number): WaiterEnd['outcome'] {
  return exitCode === 0 ? 'matched' : exitCode === 2 ? 'timeout' : 'cancelled';
}

/** CI passed (0) and failed (1) are both the answer the wait was for; 2 (timeout) and 3 (no run seen, relay down) are a wait that gave up. */
export function ciOutcomeOf(exitCode: number): WaiterEnd['outcome'] {
  return exitCode === 0 || exitCode === 1 ? 'matched' : exitCode === 2 || exitCode === 3 ? 'timeout' : 'cancelled';
}

/** What the wait tells the session while it runs. */
export interface WaitSessionReport {
  /** The event that satisfied the wait (for the history). */
  matched: (match: { eventId: string; event: string }) => void;
}

export interface RegisteredWaitParams {
  input: WaiterInput;
  deps: WaitSessionDeps;
  outcomeOf: (exitCode: number) => WaiterEnd['outcome'];
  /** The wait itself; it returns its exit code. */
  run: (session: WaitSessionReport) => Promise<number>;
}

/**
 * Registers the wait, runs it, and unregisters it. Returns the wait's exit code, or 4 when the registration is refused for something the user must change (a name that a
 * live wait holds, a filter list that is too long) and 1 when the waiters folder cannot be written (the wait is never started unlisted). Never throws for a problem of the
 * registration after it succeeded: a heartbeat or a deregister that fails is said once on stderr.
 */
export async function runRegisteredWait(params: RegisteredWaitParams): Promise<number> {
  const { input, deps } = params;
  const { registry, stderr } = deps;

  try {
    registry.sweepStale();
  } catch (error) {
    stderr.write(`[warn] could not clean up the waits that are over (${getErrorMessage(error)}); going on.\n`);
  }

  let registration: ReturnType<WaiterRegistry['register']>;
  try {
    registration = registry.register(input);
  } catch (error) {
    stderr.write(`[fail] ${getErrorMessage(error)}\n`);
    return error instanceof WaiterNameTakenError || error instanceof WaiterInputError ? 4 : 1;
  }
  const { takeover } = registration;
  if (takeover !== undefined) {
    stderr.write(`[info] took over the name '${registration.name}'${takeover.pid === undefined ? '' : ` from pid ${takeover.pid}`} (${takeover.reason})\n`);
  }

  const warned = new Set<string>();
  const warnOnce = (kind: string, text: string): void => {
    if (!warned.has(kind)) {
      warned.add(kind);
      stderr.write(`[warn] ${text}\n`);
    }
  };
  const heartbeat = (): void => {
    try {
      const result = registry.heartbeat(registration);
      if (result.status === 'reregistered') {
        warnOnce('reregistered', `the record of the wait '${registration.name}' was lost (a stall such as a sleeping machine, or a clean-up) and was registered again.`);
      } else if (result.status === 'lost' || result.status === 'failed') {
        warnOnce(result.status, result.message);
      }
    } catch (error) {
      warnOnce('threw', `could not refresh the record of the wait '${registration.name}' (${getErrorMessage(error)}); the wait goes on and tries again at the next heartbeat.`);
    }
  };

  let matchedWith: { eventId: string; event: string } | undefined;
  let ended = false;
  const stopTimer = deps.startTimer(heartbeat, WAITER_HEARTBEAT_MS);
  const finish = (outcome: WaiterEnd['outcome']): void => {
    if (ended) {
      return;
    }
    ended = true;
    stopTimer();
    dropSignals();
    dropExit();
    try {
      registry.deregister(registration, { outcome, ...(outcome === 'matched' && matchedWith !== undefined && matchedWith) });
    } catch (error) {
      stderr.write(`[warn] could not remove the record of the wait '${registration.name}' (${getErrorMessage(error)}). It disappears from the list by itself about a minute after this process ends; to remove it now, delete ${registration.path}.\n`);
    }
  };
  const dropSignals = deps.onSignals(SIGNAL_EXIT_CODES.map(([signal]) => signal), (signal) => {
    finish('cancelled');
    deps.exit(SIGNAL_EXIT_CODES.find(([candidate]) => candidate === signal)![1]);
  });
  const dropExit = deps.onExit(() => { finish('cancelled'); });

  let exitCode: number;
  try {
    exitCode = await params.run({ matched: (match) => { matchedWith = match; } });
  } catch (error) {
    finish('cancelled');
    throw error;
  }
  finish(params.outcomeOf(exitCode));
  return exitCode;
}
