import { vi } from 'vitest';

// Test helper (never imported by production code): replaces Date.now() with a logical clock that only moves when the test
// says so. Code that measures elapsed time with Date.now() (the heartbeat liveness check) then sees the elapsed time the scenario
// defines, whatever the real speed of the machine. Only Date.now() is replaced: timers and `new Date()` stay real.
export interface LogicalClock {
  /** Moves the logical time forward. */
  advance: (ms: number) => void;
  /** Puts the real Date.now() back. */
  restore: () => void;
}

export function installLogicalClock(): LogicalClock {
  const base = Date.now();
  let offsetMs = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => base + offsetMs);
  return {
    advance: (ms) => {
      offsetMs += ms;
    },
    restore: () => {
      spy.mockRestore();
    },
  };
}
