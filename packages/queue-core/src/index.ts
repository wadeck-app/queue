// violations-suppress: ts/no-barrel-index package entry point (package.json main/types): its exports are the package's public API, deleting it would expose dist internals to every consumer
// Public barrel for @wadeck-app/queue-core.
// Exposes the symbols consumed across the package boundary by queue-cli and app-module-queue.
export { getErrorMessage } from './errors.js';
export { isRecord } from './isRecord.js';
export { getQueueConfigDir } from './configDir.js';
export { getQueueProtocolInfo } from './protocolInfo.js';
export type { QueueCommands, PushRequest, PushResponse, RetryRequest, RetryResponse, StatusResponse, ListSubscribersRequest, SubscriberListResponse, DlqListResponse, DlqReplayRequest, DlqReplayResponse, DlqClearRequest, DlqClearResponse } from './daemon/QueueCommands.js';
export { createQueueService } from './daemon/QueueService.js';
export type { QueueService, QueueServiceOptions } from './daemon/QueueService.js';
export { spawnDetachedProcess } from './daemon/spawnDetachedProcess.js';
export type { SubscriberConfig } from './ConfigLoader.js';
export { SubscribersYmlSchema } from './ConfigLoader.js';
export { PayloadFilter } from './dispatch/PayloadFilter.js';
export type { FilterEvaluation } from './dispatch/PayloadFilter.js';
export type { EventEnvelope } from './types.js';
export { EventLogger } from './storage/EventLogger.js';
export { HistoryReader } from './storage/HistoryReader.js';
export type { HistoryEntry, HistoryFilter, HistorySubscriberOutcome, HistoryPage } from './storage/HistoryReader.js';
export { DEFAULT_HISTORY_LIMIT } from './storage/HistoryReader.js';
export type { DlqEntry } from './storage/DlqStore.js';
export type { ResolvedSubscriber } from './types.js';
export { readQueueCounts, listInFlightEntries, listDlqEntries, clearDlqEntries, listQueueSubscribers } from './operations.js';
export type { QueueCounts } from './operations.js';
export type { WalEntry } from './storage/Wal.js';
export { LogFormatter } from './storage/LogFormatter.js';
export { readLogTail, logFilePath, isLogDate, readDispatchDurations } from './storage/LogReader.js';
export { readLogRecords, parseLogRecord, eventOfSubscriber, LOG_OUTCOMES } from './storage/LogRecords.js';
export type { LogRecord, LogOutcome, LogRecords, LogRecordsOptions } from './storage/LogRecords.js';
export type { LogTail, LogTailOptions, DispatchDurations } from './storage/LogReader.js';
