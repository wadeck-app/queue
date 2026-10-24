// Test helper (never imported by production code). The deadline is a guard against a condition that never happens
// (a hang), not a performance limit: no test may fail because the machine is slow.
// performance.now() on purpose: tests may replace Date.now() with a logical clock
const HANG_GUARD_MS = 300_000;
const POLL_MS = 10;

/**
 * Polls `condition` until it is true. Fails with a message naming `description` only when it never became true
 * within the hang guard.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  maxMs: number = HANG_GUARD_MS
): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out after ${maxMs}ms (hung?) waiting for: ${description}`);
}
