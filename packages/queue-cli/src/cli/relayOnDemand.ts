import { registerWaiter, unregisterWaiter, markOnDemand, DEFAULT_IDLE_GRACE_MS } from '@wadeck-app/queue-relay-client/dist/onDemand.js';

/**
 * Events that reach the queue through the relay are named `on.<source>.<type>` (`on.github.workflow_run`): no
 * local `queue push` produces such a name, so waiting for one only makes sense with the relay client connected.
 */
export function isRelaySourcedEvent(eventName: string): boolean {
  return /^on\.[^.]+\.\S+$/.test(eventName);
}

export interface RelayOnDemandDeps {
  /** <configDir>/relay-daemon */
  relayDir: string;
  isRunning: () => Promise<boolean>;
  /** `queue relay start`: validates relay.yml, spawns the relay and explains any failure itself; returns its exit code. */
  startRelay: () => Promise<number>;
  io: { stderr: { write: (s: string) => void } };
}

/**
 * Lets a `queue wait` that needs the relay start it, and lets the relay stop itself afterwards.
 * `begin` declares this process as a waiter (the relay stays up while a live waiter exists), `ensureRunning` starts the
 * relay only when it is down, `end` removes the declaration. A relay that was already running is never touched, and one
 * started here is marked on-demand: only that kind stops by itself (see onDemand.ts in queue-relay-client).
 */
export class RelayOnDemand {
  private begun = false;

  constructor(private readonly deps: RelayOnDemandDeps) {}

  begin(): void {
    if (this.begun) {
      return;
    }
    this.begun = true;
    registerWaiter(this.deps.relayDir);
    // 'exit' also runs for process.exit(code); a hard kill skips it, the relay then finds the dead pid itself
    process.once('exit', () => this.end());
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
  }

  end(): void {
    unregisterWaiter(this.deps.relayDir);
  }

  /** True when the relay client is running after the call. */
  async ensureRunning(): Promise<boolean> {
    if (await this.deps.isRunning().catch(() => false)) {
      return true;
    }
    this.deps.io.stderr.write(
      `[info] The relay client is not running: starting it for this wait. It stops by itself ${Math.round(DEFAULT_IDLE_GRACE_MS / 1000)}s after the last wait ends.\n`,
    );
    if ((await this.deps.startRelay()) !== 0) {
      return false;
    }
    markOnDemand(this.deps.relayDir);
    return true;
  }
}
