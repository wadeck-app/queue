/**
 * The sleep between two reads of the history, which a wake ends early. A wake is only a HINT that the history changed: the wait re-reads it at once and decides from what it reads,
 * the sleep stays as the safety net (a lost wake costs one poll interval, nothing else). Wakes are coalesced: any number of them while the wait is reading is one extra read.
 */
export class WakeSignal {
  private pending = false;
  private release: (() => void) | undefined;

  /** The daemon (or anything that can reach the pipe) says the history may have changed. */
  wake(): void {
    if (this.release !== undefined) {
      const release = this.release;
      this.release = undefined;
      release();
    } else {
      this.pending = true;
    }
  }

  /** Sleeps `ms` with `base` (default: a timer that is cancelled by a wake), or returns at once when a wake arrived since the last sleep. */
  async sleep(ms: number, base?: (ms: number) => Promise<void>): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const woken = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    const slept = base !== undefined ? base(ms) : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    try {
      await Promise.race([slept, woken]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.release = undefined;
    }
  }
}
