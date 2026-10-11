// Public API for @wadeck-app/queue-app-module, consumed by app-core's plugin dashboard.
// Depends only on @wadeck-app/queue-core + @wadeck-app/singleton-daemon-kit -- never on
// queue-cli, so the dashboard never pulls in CLI argument-parsing or the Go-launcher bundle.
export { getStatus } from './status.js';
export type { QueueStatus } from './status.js';

export { listHistory, getHistoryEntry } from './history.js';

export { replayEvent, ReplayError } from './replay.js';

export { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
export { DaemonUnreachableError } from './errors.js';

export { listSubscribers } from './subscribers.js';

export { pushEvent } from './push.js';

export type {
  HistoryEntry,
  HistoryFilter,
  HistorySubscriberOutcome,
  PushResponse,
  DlqEntry,
  DlqReplayResponse,
  DlqClearResponse,
  ResolvedSubscriber,
} from '@wadeck-app/queue-core';
