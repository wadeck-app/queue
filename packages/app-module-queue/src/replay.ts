import { getHistoryEntry } from './history.js';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError } from './errors.js';
import type { PushResponse } from '@wadeck-app/queue-core';

export class ReplayError extends Error {}

/**
 * Resubmits a past event's recorded payload as a new event, tagged `replayOf <eventId>`.
 * Mirrors `queue replay <eventId>`. Never a silent no-op: throws ReplayError when the eventId
 * has no history entry or predates payload recording, DaemonUnreachableError when the daemon
 * is not running (the dashboard cannot spawn it -- that's the CLI's job via `queue start`).
 */
export async function replayEvent(configDir: string, eventId: string): Promise<PushResponse> {
  const entry = getHistoryEntry(configDir, eventId);
  if (!entry) {
    throw new ReplayError(`No history entry found for eventId ${eventId}`);
  }
  if (entry.payload === undefined) {
    throw new ReplayError(
      `No payload recorded for eventId ${eventId} -- it predates 'queue replay' support, or it's an orphan outcome with no trigger record`
    );
  }

  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start` before replaying');
  }

  return client.send('push', { event: entry.event, payload: entry.payload, cwd: process.cwd(), replayOf: eventId });
}
