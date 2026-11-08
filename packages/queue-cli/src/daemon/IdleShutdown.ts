/** Timers and clock, replaceable by tests (nothing in the tests waits for real time). */
export interface IdleTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: IdleTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface IdleShutdownOptions {
  /** True when no WAL entry is pending and no dispatch is running (QueueService.isIdle). */
  isIdle(): boolean;
  stop(): void | Promise<void>;
  /** A stop that failed: the daemon log is where this is said. */
  onStopError(error: unknown): void;
  /** How long the daemon must have been idle, with no command in between, before it stops. */
  timeoutMs: number;
  /** How often the idleness is looked at. */
  checkIntervalMs: number;
  timers?: IdleTimers;
}

/**
 * The idle shutdown of the daemon. Every check that starts a countdown is only a hint: when the countdown fires, the daemon looks again, and stops only if the service
 * is still idle and no command started within the timeout (a running command cancels the countdown and keeps it from starting). Every RPC command counts as activity (a retry, a dlq-replay, a give-up, a register-events, not only a push),
 * and a command that is running keeps the daemon alive however long it takes: stopping the daemon closes the requests in flight.
 */
export class IdleShutdown {
  private readonly timers: IdleTimers;
  private countdown: unknown;
  private interval: unknown;
  private runningCommands = 0;
  private lastActivityAt: number;
  private stopping = false;

  constructor(private readonly options: IdleShutdownOptions) {
    this.timers = options.timers ?? realTimers;
    this.lastActivityAt = this.timers.now();
  }

  start(): void {
    this.interval = this.timers.setInterval(() => this.check(), this.options.checkIntervalMs);
  }

  /** Records activity now; the countdown in progress, if any, re-checks when it fires. */
  noteActivity(): void {
    this.lastActivityAt = this.timers.now();
  }

  dispose(): void {
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.cancelCountdown();
  }

  /** The same commands, each one counted as activity while it runs and when it ends. */
  wrap<T extends object>(commands: T): T {
    const wrapped: Record<string, unknown> = {};
    for (const [name, command] of Object.entries(commands) as Array<[string, (payload?: unknown) => unknown]>) {
      wrapped[name] = async (payload?: unknown): Promise<unknown> => {
        this.runningCommands++;
        this.noteActivity();
        this.cancelCountdown();
        try {
          return await command(payload);
        } finally {
          this.runningCommands--;
        }
      };
    }
    return wrapped as T;
  }

  private cancelCountdown(): void {
    if (this.countdown !== undefined) {
      this.timers.clearTimeout(this.countdown);
      this.countdown = undefined;
    }
  }

  private check(): void {
    if (this.stopping) {
      return;
    }
    if (this.options.isIdle() && this.runningCommands === 0) {
      if (this.countdown === undefined) {
        this.countdown = this.timers.setTimeout(() => this.fire(), this.options.timeoutMs);
      }
    } else {
      this.cancelCountdown();
    }
  }

  private fire(): void {
    this.countdown = undefined;
    // The state at the moment of the stop, not the one when the countdown started
    if (this.stopping || !this.options.isIdle() || this.timers.now() - this.lastActivityAt < this.options.timeoutMs) {
      return;
    }
    this.stopping = true;
    this.dispose();
    const failed = (error: unknown): void => {
      // Still running: look again at the next check
      this.stopping = false;
      this.start();
      this.options.onStopError(error);
    };
    try {
      Promise.resolve(this.options.stop()).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
