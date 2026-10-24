import { join } from 'node:path';
import { Wal } from '../storage/Wal.js';
import { DlqStore } from '../storage/DlqStore.js';
import { EventLogger } from '../storage/EventLogger.js';
import { HistoryLog } from '../storage/HistoryLog.js';
import { ConfigLoader, resolveProjectName } from '../ConfigLoader.js';
import { AsyncDispatcher } from '../dispatch/AsyncDispatcher.js';
import { SyncDispatcher } from '../dispatch/SyncDispatcher.js';
import { PayloadFilter } from '../dispatch/PayloadFilter.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';
import { checkClientProtocol } from '@wadeck-app/queue-sdk/protocol';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { countQueue, subscribersFor, removeFromDlq } from '../operations.js';
import { validateSourceDeclaration, writeSourceDeclaration } from '../catalog/EventCatalog.js';
import type {
  QueueCommands, RegisterEventsRequest, RegisterEventsResponse, PushRequest, PushResponse, RetryRequest, RetryResponse, StatusResponse,
  ListSubscribersRequest, SubscriberListResponse, DlqListResponse, DlqReplayRequest, DlqReplayResponse,
  DlqClearRequest, DlqClearResponse,
} from './QueueCommands.js';

export interface QueueServiceOptions {
  /** Called when a push arrives, so the host that owns the idle shutdown can cancel its countdown. */
  onActivity?: () => void;
}

/**
 * The queue's logic, independent of how it is hosted: the RPC commands, the WAL/DLQ/history stores
 * and the dispatchers. The host (queue-cli's daemon) owns the process concerns -- the singleton daemon,
 * the port, the idle shutdown and the app-core registration -- and drives the service through this object.
 */
export interface QueueService {
  commands: QueueCommands;
  /** True when no WAL entry is pending and no dispatch is running: the host may start its idle countdown. */
  isIdle(): boolean;
  /** Reschedules the WAL entries still pending from a previous run. */
  onStart(): void;
  /** Synchronously reschedules the pending WAL entries so a retry survives the shutdown. */
  onShutdown(): void;
  eventLogger: EventLogger;
}

export function createQueueService(configDir: string, options: QueueServiceOptions = {}): QueueService {
  const wal = new Wal(join(configDir, 'wal.ndjson'));
  const dlq = new DlqStore(join(configDir, 'dlq.ndjson'));
  const eventLogger = new EventLogger(join(configDir, 'logs'));
  const historyLog = new HistoryLog(join(configDir, 'history'));
  const configLoader = new ConfigLoader(configDir);
  const syncDispatcher = new SyncDispatcher(eventLogger, historyLog);
  const startedAt = Date.now();
  const asyncDispatcher = new AsyncDispatcher(
    (id, updates) => wal.updateEntry(id, updates),
    (walEntry, lastError) => {
      dlq.append({
        id: walEntry.id,
        event: walEntry.event,
        payload: walEntry.payload,
        meta: walEntry.meta,
        subscriberId: walEntry.subscriberId,
        attempts: walEntry.attempts,
        lastError,
        movedAt: new Date().toISOString(),
      });
      wal.updateEntry(walEntry.id, { status: 'dlq' });
    },
    eventLogger,
    historyLog,
  );

  let activeDispatches = 0;

  const commands: QueueCommands = {
    async push(payload?: unknown): Promise<PushResponse> {
      const req = payload as PushRequest;
      options.onActivity?.();
      // before anything is recorded or counted: a client that speaks a protocol this daemon does not accept gets a loud refusal
      const protocol = checkClientProtocol(req.protocol);
      if (!protocol.ok) {
        return { status: 'rejected', reason: protocol.reason, supported: protocol.supported };
      }
      activeDispatches++;

      try {
        const cwd = req.cwd;
        const envelope: EventEnvelope = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event: req.event,
          payload: req.payload,
          meta: {
            cwd,
            projectName: resolveProjectName(cwd),
          },
        };

        let subscribers: ResolvedSubscriber[];
        try {
          subscribers = configLoader.getSubscribers(req.event, cwd);
        } catch (err) {
          // Invalid subscribers.yml: surface it to the caller AND to the log file
          const reason = getErrorMessage(err);
          eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `config error for event ${req.event}: ${reason}` });
          return { status: 'aborted', reason, eventId: envelope.id };
        }

        const filtered = subscribers.filter(sub => {
          if (!sub.when) {
            return true;
          }
          const evaluation = PayloadFilter.evaluate(sub.when, envelope);
          if (!evaluation.matched) {
            // Durable trace: the daemon's stderr is discarded, a `when:` typo would be invisible
            eventLogger.logFilterMiss({
              event: req.event,
              subscriberId: sub.subscriberId,
              filter: sub.when,
              reason: evaluation.reason ?? 'unknown reason',
              path: evaluation.path,
              expected: evaluation.expected,
              actual: evaluation.actual,
            });
            historyLog.logFiltered({
              eventId: envelope.id,
              event: req.event,
              subscriberId: sub.subscriberId,
              filter: sub.when,
              actual: evaluation.actual,
            });
          }
          return evaluation.matched;
        });

        // Recorded even with zero subscribers so `queue history` surfaces events nobody listens to
        historyLog.logTrigger({
          eventId: envelope.id,
          event: req.event,
          project: envelope.meta.projectName,
          matchedCount: filtered.length,
          totalCount: subscribers.length,
          payload: req.payload,
          replayOf: req.replayOf,
          cwd: req.cwd,
        });

        if (req.event.startsWith('before')) {
          const timeoutMs = req.timeout ?? 30_000;
          const syncResult = await syncDispatcher.dispatch(filtered, envelope, timeoutMs);
          if (syncResult.action === 'aborted') {
            return { status: 'aborted', reason: syncResult.reason, eventId: envelope.id };
          }
          return { status: 'dispatched', result: syncResult.payload, eventId: envelope.id };
        }

        // Async (onXxx)
        const walEntries = new Map<string, WalEntry>();
        for (const sub of filtered) {
          const walEntry: WalEntry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            event: req.event,
            payload: req.payload,
            meta: envelope.meta,
            subscriberId: sub.subscriberId,
            status: 'pending',
            attempts: 0,
          };
          wal.append(walEntry);
          walEntries.set(sub.subscriberId, walEntry);
        }

        // Fire and forget
        asyncDispatcher.dispatch(filtered, envelope, walEntries).catch((err: unknown) => {
          eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `AsyncDispatcher error for event ${req.event}: ${getErrorMessage(err)}` });
        });

        return { status: 'queued', subscriberCount: filtered.length, eventId: envelope.id };
      } finally {
        activeDispatches--;
      }
    },

    async retry(payload?: unknown): Promise<RetryResponse> {
      const req = payload as RetryRequest;
      const entries = wal.readAll();
      const entry = entries.find(e => e.id === req.eventId);
      if (!entry) {
        return { status: 'not-found' };
      }

      const cwd = entry.meta.cwd;
      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = configLoader.getSubscribers(entry.event, cwd);
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `config error for event ${entry.event}: ${getErrorMessage(err)}` });
        return { status: 'error' };
      }
      const sub = subscribers.find(s => s.subscriberId === entry.subscriberId);
      if (!sub) {
        eventLogger.logDiagnostic({
          source: 'QueueDaemon.retry',
          message: `subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}; WAL entry ${entry.id} cannot be retried`,
        });
        return { status: 'error' };
      }

      const envelope: EventEnvelope = {
        id: entry.id,
        timestamp: entry.timestamp,
        event: entry.event,
        payload: entry.payload,
        meta: entry.meta,
      };

      const walEntries = new Map([[sub.subscriberId, entry]]);
      activeDispatches++;
      asyncDispatcher.dispatch([sub], envelope, walEntries).catch((err: unknown) => {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `retry dispatch error for ${entry.subscriberId} (WAL ${entry.id}): ${getErrorMessage(err)}` });
      }).finally(() => { activeDispatches--; });

      return { status: 'ok' };
    },

    status(): StatusResponse {
      return {
        ...countQueue(wal, dlq),
        daemonRunning: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        pid: process.pid,
      };
    },

    async 'list-subscribers'(payload?: unknown): Promise<SubscriberListResponse> {
      const req = payload as ListSubscribersRequest;
      const cwd = req.cwd;
      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = subscribersFor(configLoader, { event: req?.event, cwd });
      } catch (err) {
        // Rethrow so the client reports it, but leave a durable trace first
        eventLogger.logDiagnostic({ source: 'QueueDaemon.list-subscribers', message: `config error: ${getErrorMessage(err)}` });
        throw err;
      }
      return { subscribers };
    },

    'dlq-list'(): DlqListResponse {
      return { entries: dlq.readAll() };
    },

    async 'dlq-replay'(payload?: unknown): Promise<DlqReplayResponse> {
      const req = payload as DlqReplayRequest;
      const entries = dlq.readAll();
      const entry = entries.find(e => e.id === req.id);
      if (!entry) {
        return { status: 'not-found' };
      }

      const walEntry: WalEntry = {
        id: entry.id,
        timestamp: new Date().toISOString(),
        event: entry.event,
        payload: entry.payload,
        meta: entry.meta,
        subscriberId: entry.subscriberId,
        status: 'pending',
        attempts: 0,
      };
      wal.append(walEntry);
      dlq.remove(entry.id);

      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = configLoader.getSubscribers(entry.event, entry.meta.cwd);
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `config error for event ${entry.event}: ${getErrorMessage(err)}` });
        return { status: 'ok' };
      }
      const sub = subscribers.find(s => s.subscriberId === entry.subscriberId);
      if (!sub) {
        eventLogger.logDiagnostic({
          source: 'QueueDaemon.dlq-replay',
          message: `subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}; WAL entry ${walEntry.id} stays pending`,
        });
        return { status: 'ok' };
      }

      const envelope: EventEnvelope = {
        id: walEntry.id,
        timestamp: walEntry.timestamp,
        event: walEntry.event,
        payload: walEntry.payload,
        meta: walEntry.meta,
      };
      const walEntries = new Map([[sub.subscriberId, walEntry]]);
      asyncDispatcher.dispatch([sub], envelope, walEntries).catch((err: unknown) => {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `replay dispatch error for ${entry.subscriberId} (WAL ${walEntry.id}): ${getErrorMessage(err)}` });
      });

      return { status: 'ok' };
    },

    // Protocol 1.1.0. The daemon is the only writer of the catalog; readers read the files. Nothing is queued or dispatched.
    'register-events'(payload?: unknown): RegisterEventsResponse {
      const req = (payload ?? {}) as Partial<RegisterEventsRequest>;
      const protocol = checkClientProtocol(req.protocol);
      if (!protocol.ok) {
        return { status: 'rejected', reason: protocol.reason, supported: protocol.supported };
      }
      const checked = validateSourceDeclaration({ source: req.source, events: req.events });
      if (!checked.ok) {
        return {
          status: 'rejected',
          reason: `the declaration is invalid: ${checked.problems.map((problem) => `${problem.path || 'declaration'}: ${problem.message}`).join('; ')}`,
          problems: checked.problems,
        };
      }
      writeSourceDeclaration(configDir, checked.declaration);
      return { status: 'registered', source: checked.declaration.source, count: checked.declaration.events.length };
    },

    'dlq-clear'(payload?: unknown): DlqClearResponse {
      const req = payload as DlqClearRequest | undefined;
      return { cleared: removeFromDlq(dlq, req?.id) };
    },
  };

  return {
    commands,
    eventLogger,
    isIdle: () => wal.pendingCount() === 0 && activeDispatches === 0,
    onStart: () => {
      // Startup scan: reschedule pending WAL entries
      const pending = wal.readAll().filter(e => e.status === 'pending');
      for (const entry of pending) {
        try {
          RetryScheduler.scheduleRetry(entry);
        } catch (err) {
          // orch may not be available; best-effort, but the skipped entry must be traceable
          eventLogger.logDiagnostic({
            source: 'QueueDaemon.onStart',
            message: `could not reschedule pending WAL entry ${entry.id} (${entry.subscriberId}): ${getErrorMessage(err)}`,
          });
        }
      }
    },
    onShutdown: () => {
      // Shutdown scan: sync reschedule
      const pending = wal.readAll().filter(e => e.status === 'pending');
      for (const entry of pending) {
        try {
          RetryScheduler.scheduleRetry(entry, true);
        } catch (err) {
          eventLogger.logDiagnostic({
            source: 'QueueDaemon.onShutdown',
            message: `could not reschedule pending WAL entry ${entry.id} (${entry.subscriberId}): ${getErrorMessage(err)}`,
          });
        }
      }
    },
  };
}
