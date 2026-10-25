// violations-suppress: ts/no-barrel-index package entry point (package.json main/types): its exports are the package's public API, deleting it would expose dist internals to every consumer
// Public barrel for @wadeck-app/queue-core.
// Exposes the symbols consumed across the package boundary by queue-cli and app-module-queue.
export { getErrorMessage } from './errors.js';
export { isRecord } from './isRecord.js';
export { getQueueConfigDir } from './configDir.js';
export { getQueueProtocolInfo } from './protocolInfo.js';
export { PROTOCOL_VERSION } from '@wadeck-app/queue-sdk/protocol';
export { validateSourceDeclaration, writeSourceDeclaration, readCatalog, MAX_EVENTS_PER_SOURCE, EVENT_OUTCOMES } from './catalog/EventCatalog.js';
export type { EventDeclaration, SourceDeclaration, CatalogProblem, Validation, StoredSource, Catalog, EventOutcome } from './catalog/EventCatalog.js';
export { listEvents, listEventDetails, getEventDetail, nearestEventNames, OBSERVED_WINDOW_DAYS } from './catalog/EventListing.js';
export type { CatalogEntry, SourceSummary, EventListing, ListEventsOptions, FilterableField, EventDetail } from './catalog/EventListing.js';
export type { QueueCommands, RegisterEventsRequest, RegisterEventsResponse, PushRequest, PushResponse, RetryRequest, RetryResponse, StatusResponse, ListSubscribersRequest, SubscriberListResponse, DlqListResponse, DlqReplayRequest, DlqReplayResponse, DlqClearRequest, DlqClearResponse } from './daemon/QueueCommands.js';
export { createQueueService } from './daemon/QueueService.js';
export type { QueueService, QueueServiceOptions } from './daemon/QueueService.js';
export { spawnDetachedProcess } from './daemon/spawnDetachedProcess.js';
export type { SubscriberConfig } from './ConfigLoader.js';
export { SubscribersYmlSchema, SUBSCRIBER_NAME_FORMAT, isValidSubscriberName, unnamedSubscriberAdvice } from './ConfigLoader.js';
export { PayloadFilter } from './dispatch/PayloadFilter.js';
export type { FilterEvaluation } from './dispatch/PayloadFilter.js';
export type { EventEnvelope } from './types.js';
export { EventLogger } from './storage/EventLogger.js';
export { HistoryReader } from './storage/HistoryReader.js';
export type { HistoryEntry, HistoryFilter, HistorySubscriberOutcome, HistoryPage } from './storage/HistoryReader.js';
export { DEFAULT_HISTORY_LIMIT } from './storage/HistoryReader.js';
export type { DlqEntry } from './storage/DlqStore.js';
export type { ResolvedSubscriber } from './types.js';
export { readQueueCounts, listInFlightEntries, listDlqEntries, clearDlqEntries, listQueueSubscribers, abandonInFlightEntry, abandonStuckEntries, countStuckEntries, STUCK_AFTER_MS } from './operations.js';
export type { AbandonResult } from './operations.js';
export type { QueueCounts } from './operations.js';
export type { WalEntry } from './storage/Wal.js';
export { LogFormatter } from './storage/LogFormatter.js';
export { readLogTail, logFilePath, isLogDate, readDispatchDurations } from './storage/LogReader.js';
export { readLogRecords, parseLogRecord, eventOfSubscriber, LOG_OUTCOMES } from './storage/LogRecords.js';
export type { LogRecord, LogOutcome, LogRecords, LogRecordsOptions } from './storage/LogRecords.js';
export type { LogTail, LogTailOptions, DispatchDurations } from './storage/LogReader.js';
