import { existsSync } from 'node:fs';
import { getHistoryEntry } from './history.js';
import { createQueueAppClient } from './client.js';
import { DaemonUnreachableError, ReplayError, ReplayNotFoundError } from './errors.js';
import type { PushResponse } from '@wadeck-app/queue-core';

/**
 * Resubmits a past event's recorded payload as a new event, tagged `replayOf <eventId>`.
 * Mirrors `queue replay <eventId>`. Never a silent no-op: throws ReplayError when the eventId
 * has no history entry or predates payload recording, DaemonUnreachableError when the daemon
 * is not running (the dashboard cannot spawn it -- that's the CLI's job via `queue start`).
 */
export async function replayEvent(configDir: string, eventId: string): Promise<PushResponse> {
  const entry = getHistoryEntry(configDir, eventId);
  if (!entry) {
    throw new ReplayNotFoundError(`No history entry found for eventId ${eventId}`);
  }
  if (entry.payload === undefined) {
    throw new ReplayError(
      `No payload recorded for eventId ${eventId} -- it predates 'queue replay' support, or it's an orphan outcome with no trigger record`
    );
  }

  // Check cwd: if not recorded, error with instruction; if recorded but missing, error with instruction
  if (!entry.cwd) {
    throw new ReplayError(
      `History entry ${eventId} has no recorded working directory (it predates cwd recording), so the original project cannot be determined. Replay it from a terminal and name the project directory: queue replay ${eventId} --cwd <project>`
    );
  }
  if (!existsSync(entry.cwd)) {
    throw new ReplayError(
      `The working directory recorded for event ${eventId} no longer exists: ${entry.cwd}. Replay it from a terminal and name the project directory: queue replay ${eventId} --cwd <project>`
    );
  }

  const client = createQueueAppClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    throw new DaemonUnreachableError('Daemon is not running -- start it with `queue start` before replaying');
  }

  return client.send('push', { event: entry.event, payload: entry.payload, cwd: entry.cwd, replayOf: eventId });
}
