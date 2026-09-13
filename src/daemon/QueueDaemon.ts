import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonHandle, ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { join } from 'node:path';
import { Wal } from '../storage/Wal.js';
import { DlqStore } from '../storage/DlqStore.js';
import { EventLogger } from '../storage/EventLogger.js';
import { ConfigLoader, resolveProjectName } from '../ConfigLoader.js';
import { AsyncDispatcher } from '../dispatch/AsyncDispatcher.js';
import { SyncDispatcher } from '../dispatch/SyncDispatcher.js';
import { PayloadFilter } from '../dispatch/PayloadFilter.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';
import type { DlqEntry } from '../storage/DlqStore.js';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';

export const DAEMON_PORT = 47910;
export const IDLE_TIMEOUT_MS = 60_000;

export interface PushRequest { event: string; payload: unknown; timeout?: number; cwd: string; }
export interface PushResponse { status: 'dispatched' | 'queued' | 'aborted'; result?: unknown; reason?: string; subscriberCount?: number; }
export interface RetryRequest { eventId: string; }
export interface RetryResponse { status: 'ok' | 'not-found' | 'error'; }
export interface StatusResponse { pendingCount: number; dlqCount: number; daemonRunning: true; uptimeSec: number; pid: number; }
export interface ListSubscribersRequest { event?: string; cwd: string; }
export interface SubscriberListResponse { subscribers: ResolvedSubscriber[]; }
export interface DlqListResponse { entries: DlqEntry[]; }
export interface DlqReplayRequest { id: string; }
export interface DlqReplayResponse { status: 'ok' | 'not-found'; }
export interface DlqClearRequest { id?: string; }
export interface DlqClearResponse { cleared: number; }

export type QueueCommands = {
  push: (payload?: unknown) => Promise<PushResponse>;
  retry: (payload?: unknown) => Promise<RetryResponse>;
  status: (payload?: unknown) => StatusResponse;
  'list-subscribers': (payload?: unknown) => Promise<SubscriberListResponse>;
  'dlq-list': (payload?: unknown) => DlqListResponse;
  'dlq-replay': (payload?: unknown) => Promise<DlqReplayResponse>;
  'dlq-clear': (payload?: unknown) => DlqClearResponse;
};

export async function startDaemon(configDir: string): Promise<void> {
  const wal = new Wal(join(configDir, 'wal.ndjson'));
  const dlq = new DlqStore(join(configDir, 'dlq.ndjson'));
  const eventLogger = new EventLogger(join(configDir, 'logs'));
  const configLoader = new ConfigLoader(configDir);
  const syncDispatcher = new SyncDispatcher(eventLogger);
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
  );

  let activeDispatches = 0;
  let idleCountdown: ReturnType<typeof setTimeout> | null = null;
  let daemonHandle: DaemonHandle | null = null;

  function resetIdleCountdown(): void {
    if (idleCountdown) {
      clearTimeout(idleCountdown);
      idleCountdown = null;
    }
  }

  function maybeStartIdleCountdown(): void {
    if (wal.pendingCount() === 0 && activeDispatches === 0) {
      if (!idleCountdown) {
        idleCountdown = setTimeout(() => {
          daemonHandle?.stop('idle' as ShutdownReason).catch((err: unknown) => {
            eventLogger.logDiagnostic({ source: 'QueueDaemon.idleShutdown', message: `idle stop failed: ${getErrorMessage(err)}` });
          });
        }, IDLE_TIMEOUT_MS);
      }
    } else {
      resetIdleCountdown();
    }
  }

  const idleCheckInterval = setInterval(maybeStartIdleCountdown, 10_000);

  const commands: QueueCommands = {
    async push(payload?: unknown): Promise<PushResponse> {
      const req = payload as PushRequest;
      resetIdleCountdown();
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
          return { status: 'aborted', reason };
        }

        const filtered = subscribers.filter(sub => {
          if (!sub.when) return true;
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
          }
          return evaluation.matched;
        });

        if (req.event.startsWith('before')) {
          const timeoutMs = req.timeout ?? 30_000;
          const syncResult = await syncDispatcher.dispatch(filtered, envelope, timeoutMs);
          if (syncResult.action === 'aborted') {
            return { status: 'aborted', reason: syncResult.reason };
          }
          return { status: 'dispatched', result: syncResult.payload };
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

        return { status: 'queued', subscriberCount: filtered.length };
      } finally {
        activeDispatches--;
      }
    },

    async retry(payload?: unknown): Promise<RetryResponse> {
      const req = payload as RetryRequest;
      const entries = wal.readAll();
      const entry = entries.find(e => e.id === req.eventId);
      if (!entry) return { status: 'not-found' };

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
        pendingCount: wal.pendingCount(),
        dlqCount: dlq.readAll().length,
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
        if (req?.event) {
          subscribers = configLoader.getSubscribers(req.event, cwd);
        } else {
          const all = configLoader.load(cwd);
          subscribers = Array.from(all.values()).flat();
        }
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
      if (!entry) return { status: 'not-found' };

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

    'dlq-clear'(payload?: unknown): DlqClearResponse {
      const req = payload as DlqClearRequest | undefined;
      if (req?.id) {
        dlq.remove(req.id);
        return { cleared: 1 };
      }
      const count = dlq.clear();
      return { cleared: count };
    },
  };

  const handle = await createDaemon({
    configDir,
    port: DAEMON_PORT,
    idleTimeout: null,
    commands,
    hooks: {
      onStart: (_port: number) => {
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
      onShutdown: (_reason: ShutdownReason) => {
        clearInterval(idleCheckInterval);
        resetIdleCountdown();
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
    },
  });

  daemonHandle = handle;
}
