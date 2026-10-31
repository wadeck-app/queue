import { join } from 'node:path';
import { Wal } from '../storage/Wal.js';
import { DlqStore } from '../storage/DlqStore.js';
import { EventLogger } from '../storage/EventLogger.js';
import { HistoryLog, projectRefsOf } from '../storage/HistoryLog.js';
import { ConfigLoader, resolveProjectName } from '../ConfigLoader.js';
import { ProjectResolver, type ProjectLookup } from '../project/ProjectResolver.js';
import { AsyncDispatcher } from '../dispatch/AsyncDispatcher.js';
import { SyncDispatcher } from '../dispatch/SyncDispatcher.js';
import { PayloadFilter } from '../dispatch/PayloadFilter.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { ActionTransport } from '../dispatch/ActionTransport.js';
import type { ActionRegistry } from '../actions/ActionRegistry.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPushRequest, ActionPushResult } from '../actions/ActionPlugin.js';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';
import { checkClientProtocol, checkPushDirection } from '@wadeck-app/queue-sdk/protocol';
import type { PushDirection } from '@wadeck-app/queue-sdk/protocol';
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
  /**
   * The project-sdk registry directory: the project of a push comes from the registered path that contains its working directory.
   * Absent, no project is looked up (tests; the daemon always passes it).
   */
  registryDir?: string;
  /**
   * The action plugins this process can run (`type: action` subscribers). Absent, only the generic `emit` is available.
   * The subscribers.yml is checked strictly against it: an unknown action fails that subscriber alone, for good.
   */
  actions?: ActionRegistry;
}

/** An action chain (an action emits an event whose subscriber emits again...) is cut at this many hops: the event that would exceed it is refused. */
export const MAX_ACTION_HOPS = 5;
/** Largest payload an action may emit, serialized as JSON, in bytes. */
export const MAX_EMITTED_PAYLOAD_BYTES = 64 * 1024;

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

/** The subscriber a WAL or DLQ entry was written for, by its id; none when it was renamed or removed (the caller reports "no longer exists"). */
function findSubscriber(subscribers: ResolvedSubscriber[], entrySubscriberId: string): ResolvedSubscriber | undefined {
  return subscribers.find((s) => s.subscriberId === entrySubscriberId);
}

export function createQueueService(configDir: string, options: QueueServiceOptions = {}): QueueService {
  // What was already said, once per daemon run: a push happens many times and the same sentence each time would hide the others
  const saidOnce = new Set<string>();
  const projectResolver = options.registryDir === undefined ? undefined : new ProjectResolver(options.registryDir);

  /**
   * The subscribers of an event: the global file, then those of the registered project (its config folders); a .queue/subscribers.yml found
   * above `cwd` is refused by the loader. `lookup` is the project already found by the caller; `projectId` names it explicitly (a stored entry).
   */
  function loadSubscribers(event: string, cwd: string | undefined, lookup?: ProjectLookup, projectId?: string, directions?: readonly PushDirection[]): ResolvedSubscriber[] {
    const known = lookup ?? (projectResolver === undefined ? undefined : projectId !== undefined ? projectResolver.lookupId(projectId) : cwd === undefined ? undefined : projectResolver.lookup(cwd));
    const source = known?.kind === 'registered' ? projectResolver?.configSource(known.project.id, directions) : undefined;
    const subscribers = configLoader.getSubscribers(event, cwd, source);
    const registryFile = subscribers.find((sub) => sub.via === 'registry')?.file;
    if (registryFile !== undefined) {
      const legacy = cwd === undefined ? null : configLoader.findProjectFile(cwd);
      const note = `${legacy} is ignored: the subscribers of this project are in ${registryFile}. Delete the old file once its content is there`;
      if (legacy !== null && !saidOnce.has(note)) {
        saidOnce.add(note);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: note });
      }
    }
    return subscribers;
  }
  const wal = new Wal(join(configDir, 'wal.ndjson'));
  const dlq = new DlqStore(join(configDir, 'dlq.ndjson'));
  const eventLogger = new EventLogger(join(configDir, 'logs'));
  const historyLog = new HistoryLog(join(configDir, 'history'));
  const actions = options.actions ?? createActionRegistry();
  const configLoader = new ConfigLoader(configDir, { actions });
  // The context of a run is bound lazily to the internal push: the transport exists before the push it will call
  const actionTransport = new ActionTransport(actions, (source) => ({ push: (request) => emitFrom(source, request) }));
  const syncDispatcher = new SyncDispatcher(eventLogger, historyLog, actionTransport);
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
    actionTransport,
  );

  let activeDispatches = 0;

  /**
   * The event an action pushes. It is filed under the project (and working directory) of the envelope the subscriber received, never one the plugin
   * names; the hop counter comes from that envelope and is set on the new event by the internal push only. A refusal that would repeat on a retry is permanent.
   */
  async function emitFrom(source: EventEnvelope, request: ActionPushRequest): Promise<ActionPushResult> {
    const hops = source.meta.hops ?? 0;
    if (hops >= MAX_ACTION_HOPS) {
      return {
        success: false,
        permanent: true,
        error: `loop guard: the event '${source.event}' was itself emitted by ${hops} actions in a chain (cap ${MAX_ACTION_HOPS}), so '${request.event}' was not emitted. Fix: break the cycle between the action subscribers of subscribers.yml (an action that emits an event another action listens to).`,
      };
    }
    // A before* event is dispatched synchronously and answers once: an action has nobody to answer to
    if (request.event.startsWith('before')) {
      return {
        success: false,
        permanent: true,
        error: `an action cannot emit '${request.event}': a 'before*' event is synchronous and answers its pusher. Fix: emit an 'on*' event instead.`,
      };
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(request.payload);
    } catch (err) {
      return { success: false, permanent: true, error: `the payload of '${request.event}' cannot be written as JSON (${getErrorMessage(err)})` };
    }
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_EMITTED_PAYLOAD_BYTES) {
      return {
        success: false,
        permanent: true,
        error: `the payload of '${request.event}' is ${bytes} bytes, over the ${MAX_EMITTED_PAYLOAD_BYTES} bytes an action may emit. Fix: send fewer or smaller fields.`,
      };
    }
    const response = await pushInternal(
      {
        event: request.event,
        payload: request.payload,
        ...(source.meta.cwd !== undefined && { cwd: source.meta.cwd }),
        // The registered project of the received envelope (the descendant's for to-children); a virtual project has no folder to find it by
        ...(source.meta.projectId !== undefined && { project: source.meta.projectId }),
      },
      { hops: hops + 1 },
    );
    switch (response.status) {
      case 'queued':
      case 'dispatched':
        return { success: true, ...(response.eventId !== undefined && { eventId: response.eventId }) };
      case 'aborted':
        // Typically a subscribers.yml that does not load right now: fixing it and retrying can work
        return { success: false, error: `the event '${request.event}' was aborted: ${response.reason ?? 'no reason given'}` };
      case 'rejected':
        return { success: false, permanent: true, error: `the event '${request.event}' was rejected: ${response.reason ?? 'no reason given'}` };
    }
  }

  /**
   * Records an event and dispatches it. `hops` is how many actions in a chain emitted it: it is given by the daemon's own code only, never by a client
   * (it is not part of PushRequest and is not read from the wire); the RPC push starts every event at 0.
   */
  async function pushInternal(req: PushRequest, internal: { hops: number }): Promise<PushResponse> {
    // before anything is recorded or counted: a client that speaks a protocol this daemon does not accept gets a loud refusal
    const protocol = checkClientProtocol(req.protocol);
    if (!protocol.ok) {
      return { status: 'rejected', reason: protocol.reason, supported: protocol.supported };
    }
    // Same for the direction: a wrong value or a combination that cannot work is refused before anything is recorded
    const direction = checkPushDirection(req.direction);
    if (!direction.ok) {
      return { status: 'rejected', reason: `${direction.reason}; the event was not recorded` };
    }
    const toChildren = direction.directions.includes('to-children');
    if (toChildren && req.event.startsWith('before')) {
      return { status: 'rejected', reason: "a 'before*' event is dispatched synchronously and answers once: it cannot propagate to-children. Fix: push it without direction (to-parents), or use an 'on*' event; the event was not recorded" };
    }
    // An explicit project is checked before anything is recorded: a wrong id must not file the event under nothing, silently
    let explicit: ProjectLookup | undefined;
    if (req.project !== undefined) {
      if (projectResolver === undefined) {
        return { status: 'rejected', reason: `this daemon has no project registry to check the project '${req.project}' against, so it did not record the event` };
      }
      explicit = projectResolver.lookupId(req.project);
      if (explicit.kind !== 'registered') {
        return { status: 'rejected', reason: `${explicit.kind === 'unavailable' ? explicit.problem : explicit.warning}; the event was not recorded` };
      }
    }
    // Without a working directory the project is the only thing that says where the event comes from: a virtual project has no folder
    if (req.cwd === undefined && req.project === undefined) {
      return { status: 'rejected', reason: "the push has neither a 'cwd' nor a 'project': the daemon cannot tell which project the event belongs to. Fix: send the working directory, or name the project (queue push --project <name|alias|id>)" };
    }
    activeDispatches++;

    try {
      const cwd = req.cwd;
      const lookup: ProjectLookup | undefined = explicit ?? (cwd === undefined ? undefined : projectResolver?.lookup(cwd));
      const problem = lookup?.kind === 'unavailable' ? lookup.problem : lookup?.kind === 'unregistered' ? lookup.warning : undefined;
      if (problem !== undefined && !saidOnce.has(problem)) {
        saidOnce.add(problem);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: problem });
      }
      if (toChildren && lookup?.kind !== 'registered') {
        return { status: 'rejected', reason: `direction to-children needs the event to belong to a registered project (its descendants come from the project registry), and ${lookup?.kind === 'unavailable' ? lookup.problem : lookup?.kind === 'unregistered' ? lookup.warning : 'no registry is available'}; the event was not recorded` };
      }
      const eventId = crypto.randomUUID();
      const envelope: EventEnvelope = {
        id: eventId,
        timestamp: new Date().toISOString(),
        event: req.event,
        payload: req.payload,
        meta: {
          cwd,
          projectName: cwd !== undefined ? resolveProjectName(cwd) : lookup?.kind === 'registered' ? lookup.project.name : undefined,
          ...(lookup?.kind === 'registered' && { projectId: lookup.project.id }),
          // The id of this first push: a retry or a dlq-replay gets a new WAL id, an action template renders this one
          eventId,
          ...(internal.hops > 0 && { hops: internal.hops }),
        },
      };

      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = loadSubscribers(req.event, cwd, lookup, undefined, direction.directions);
      } catch (err) {
        // Invalid subscribers.yml: surface it to the caller AND to the log file
        const reason = getErrorMessage(err);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `config error for event ${req.event}: ${reason}` });
        return { status: 'aborted', reason, eventId: envelope.id };
      }

      // A subscriber of a descendant (to-children) is dispatched under its own project: its envelope shares the event id and carries the emitter
      const descendantEnvelopes = new Map<string, EventEnvelope>();
      const envelopeFor = (sub: ResolvedSubscriber): EventEnvelope => {
        if (sub.fromDescendant !== true || sub.projectId === undefined) {
          return envelope;
        }
        let own = descendantEnvelopes.get(sub.projectId);
        if (own === undefined) {
          own = {
            ...envelope,
            meta: {
              ...envelope.meta,
              projectId: sub.projectId,
              ...(sub.projectName !== undefined && { projectName: sub.projectName }),
              ...(envelope.meta.projectId !== undefined && { emitterProjectId: envelope.meta.projectId }),
            },
          };
          descendantEnvelopes.set(sub.projectId, own);
        }
        return own;
      };

      const filtered = subscribers.filter(sub => {
        if (!sub.when) {
          return true;
        }
        const evaluation = PayloadFilter.evaluate(sub.when, envelopeFor(sub));
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
            ...projectRefsOf(envelopeFor(sub).meta),
          });
        }
        return evaluation.matched;
      });

      // Recorded even with zero subscribers so `queue history` surfaces events nobody listens to
      historyLog.logTrigger({
        eventId: envelope.id,
        event: req.event,
        project: envelope.meta.projectName,
        ...(envelope.meta.projectId !== undefined && { projectId: envelope.meta.projectId }),
        matchedCount: filtered.length,
        totalCount: subscribers.length,
        payload: req.payload,
        replayOf: req.replayOf,
        cwd: req.cwd,
        ...(!(direction.directions.length === 1 && direction.directions[0] === 'to-parents') && { direction: direction.directions }),
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
          meta: envelopeFor(sub).meta,
          subscriberId: sub.subscriberId,
          status: 'pending',
          attempts: 0,
        };
        wal.append(walEntry);
        walEntries.set(sub.subscriberId, walEntry);
      }

      // Fire and forget
      const groups = new Map<EventEnvelope, ResolvedSubscriber[]>();
      for (const sub of filtered) {
        const groupEnvelope = envelopeFor(sub);
        groups.set(groupEnvelope, [...(groups.get(groupEnvelope) ?? []), sub]);
      }
      for (const [groupEnvelope, groupSubscribers] of groups) {
        asyncDispatcher.dispatch(groupSubscribers, groupEnvelope, walEntries).catch((err: unknown) => {
          eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `AsyncDispatcher error for event ${req.event}: ${getErrorMessage(err)}` });
        });
      }

      return { status: 'queued', subscriberCount: filtered.length, eventId: envelope.id };
    } finally {
      activeDispatches--;
    }
}

  const commands: QueueCommands = {
    async push(payload?: unknown): Promise<PushResponse> {
      options.onActivity?.();
      return pushInternal(payload as PushRequest, { hops: 0 });
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
        subscribers = loadSubscribers(entry.event, cwd, undefined, entry.meta.projectId);
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `config error for event ${entry.event}: ${getErrorMessage(err)}` });
        return { status: 'error' };
      }
      const sub = findSubscriber(subscribers, entry.subscriberId);
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
        subscribers = subscribersFor(configLoader, { event: req?.event, cwd, ...(projectResolver !== undefined && { project: projectResolver.resolve(cwd).source }) });
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
        subscribers = loadSubscribers(entry.event, entry.meta.cwd, undefined, entry.meta.projectId);
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `config error for event ${entry.event}: ${getErrorMessage(err)}` });
        return { status: 'ok' };
      }
      const sub = findSubscriber(subscribers, entry.subscriberId);
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
