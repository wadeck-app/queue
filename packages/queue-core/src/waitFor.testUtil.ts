/** Test helper: polls a real condition instead of sleeping and hoping. */

/** A guard against a condition that never comes (hung?), never a performance limit: a slow machine must not trip it. */
const WAIT_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 20;

/** Resolves as soon as `condition` is true; rejects after the guard deadline with a message naming what never happened. */
export async function waitFor(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Waited ${WAIT_DEADLINE_MS} ms and this never happened (hung?): ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
