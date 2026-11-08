import { join } from 'node:path';
import { Wal } from '../storage/Wal.js';
import { DlqStore, type DlqEntry } from '../storage/DlqStore.js';
import { EventLogger } from '../storage/EventLogger.js';
import { HistoryLog, projectRefsOf, type CausedBy } from '../storage/HistoryLog.js';
import { HistoryReader } from '../storage/HistoryReader.js';
import { ConfigLoader, resolveProjectName, type ProjectConfigSource } from '../ConfigLoader.js';
import { ProjectResolver, type ProjectLookup } from '../project/ProjectResolver.js';
import { AsyncDispatcher, inFlightWalUpdater } from '../dispatch/AsyncDispatcher.js';
import { SyncDispatcher } from '../dispatch/SyncDispatcher.js';
import { PayloadFilter } from '../dispatch/PayloadFilter.js';
import { RetryScheduler, backoffMinutes } from '../dispatch/RetryScheduler.js';
import { ActionTransport } from '../dispatch/ActionTransport.js';
import { RefResolver } from '../dispatch/refResolver.js';
import { reservedEventProblem } from '../reservedEvents.js';
import { describeSearchPath } from '../dispatch/windowsProgram.js';
import type { ActionRegistry } from '../actions/ActionRegistry.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import { MAX_ACTION_HOPS, MAX_ACTION_EMISSIONS_PER_ROOT } from '../actions/hopCap.js';
import { EmissionBudget } from '../actions/EmissionBudget.js';
import type { ActionPushRequest, ActionPushResult } from '../actions/ActionPlugin.js';
import { findActionCycles, type CycleSubscriber } from '../actions/findActionCycles.js';
import type { WalEntry } from '../storage/Wal.js';
import { getErrorMessage } from '../errors.js';
import { checkClientProtocol, checkPushDirection, isReservedEventName, payloadSizeProblem, RESERVED_EVENT_PREFIX } from '@wadeck-app/queue-sdk/protocol';
import type { PushDirection } from '@wadeck-app/queue-sdk/protocol';
import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import { countQueue, subscribersFor, removeDlqEntries, purgeWalOfDlqRows, abandonInFlightEntryDetailed, abandonStuckEntriesDetailed, pruneOrphanedDlqWalEntries, type DlqChanges } from '../operations.js';
import {
  buildDlqAddedEvent, buildDlqRemovedEvent, isDlqEventExcluded, runBounded, DLQ_EVENT_BATCH_SIZE, DLQ_EVENT_DECLARATIONS,
  type BuiltDlqEvent, type DlqAddedInfo, type DlqRemovedReason,
} from '../dlqEvents.js';
import { validateSourceDeclaration, writeSourceDeclaration } from '../catalog/EventCatalog.js';
import type {
  QueueCommands, RegisterEventsRequest, RegisterEventsResponse, PushRequest, PushResponse, RetryRequest, RetryResponse, StatusResponse,
  ListSubscribersRequest, SubscriberListResponse, DlqListResponse, DlqReplayRequest, DlqReplayResponse,
  DlqClearRequest, DlqClearResponse, GiveUpResponse, GiveUpStuckResponse,
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
  /**
   * Records and dispatches an event the daemon builds about itself, the only way to a `queue.` event name: it carries `meta.origin = 'queue'`, the condition
   * under which the payload references of `queue.dlq.*` events are followed. Internal to the daemon process: no RPC command, wire request or action reaches it.
   */
  pushDaemonEvent(request: PushRequest, options?: { hops?: number; causedBy?: CausedBy }): Promise<PushResponse>;
}

/** What emitDlqEvent did: `emitted`; `excluded` (base event in the queue. namespace) and `skipped` (hop cap) are deliberate; `failed` is not (aborted, rejected, thrown). */
type DlqEmitOutcome = 'emitted' | 'excluded' | 'skipped' | 'failed';

/** The subscriber a WAL or DLQ entry was written for, by its id; none when it was renamed or removed (the caller reports "no longer exists"). */
function findSubscriber(subscribers: ResolvedSubscriber[], entrySubscriberId: string): ResolvedSubscriber | undefined {
  return subscribers.find((s) => s.subscriberId === entrySubscriberId);
}

export function createQueueService(configDir: string, options: QueueServiceOptions = {}): QueueService {
  // What was already said, once per daemon run: a push happens many times and the same sentence each time would hide the others
  const saidOnce = new Set<string>();
  // True when a DLQ row may be waiting for its queue.dlq.added event (a mark `pending`): the daemon looks at its start and after the next successful push. A flag, no timer.
  let announceBacklog = true;
  let announceRetryRunning = false;
  const projectResolver = options.registryDir === undefined ? undefined : new ProjectResolver(options.registryDir);

  /**
   * The subscribers of an event: the global file, then those of the registered project (its config folders); a .queue/subscribers.yml found
   * above `cwd` is refused by the loader. `lookup` is the project already found by the caller; `projectId` names it explicitly (a stored entry).
   */
  function loadSubscribers(event: string, cwd: string | undefined, lookup?: ProjectLookup, projectId?: string, directions?: readonly PushDirection[]): ResolvedSubscriber[] {
    const known = lookup ?? (projectResolver === undefined ? undefined : projectId !== undefined ? projectResolver.lookupId(projectId) : cwd === undefined ? undefined : projectResolver.lookup(cwd));
    const source = known?.kind === 'registered' ? projectResolver?.configSource(known.project.id, directions) : undefined;
    const subscribers = configLoader.getSubscribers(event, cwd, source);
    reportConfigProblems(subscribers);
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
  /** Says what stops a subscriber from running, once per daemon run: without it the subscriber looks healthy until an event fires and lands in the DLQ. */
  function reportConfigProblems(subscribers: readonly ResolvedSubscriber[]): void {
    for (const sub of subscribers) {
      if (sub.configProblem === undefined) {
        continue;
      }
      const message = `subscriber ${sub.subscriberId} (event '${sub.event}', ${sub.file}) cannot run: ${sub.configProblem} Its events go to the dead-letter queue until this is fixed (queue dlq list).`;
      if (!saidOnce.has(message)) {
        saidOnce.add(message);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.config', message });
      }
    }
  }
  const eventLogger = new EventLogger(join(configDir, 'logs'));
  // The daemon's stderr is ignored: what the queue files have to say (unreadable lines kept aside, a full DLQ) goes to the daemon log, where `queue logs` shows it
  const wal = new Wal(join(configDir, 'wal.ndjson'), { onDiagnostic: (diagnostic) => eventLogger.logDiagnostic(diagnostic) });
  const dlq = new DlqStore(join(configDir, 'dlq.ndjson'), undefined, { onDiagnostic: (diagnostic) => eventLogger.logDiagnostic(diagnostic) });
  // History retention runs when a new day's file is created; what it reports lands in the daemon log (queue logs)
  const historyLog = new HistoryLog(join(configDir, 'history'), lines => {
    for (const line of lines) eventLogger.logDiagnostic({ source: 'HistoryRetention', message: line.message, level: line.level });
  });
  const actions = options.actions ?? createActionRegistry();
  const configLoader = new ConfigLoader(configDir, { actions });
  // The context of a run is bound lazily to the internal push: the transport exists before the push it will call
  // Follows the payload references of the events the daemon builds (the policy is canResolveRef): the base event is read from the history, lazily
  const historyReader = new HistoryReader(join(configDir, 'history'));
  const refs = new RefResolver((eventId) => {
    const trigger = historyReader.findTrigger(eventId);
    return trigger === undefined ? undefined : { payload: trigger.payload };
  });
  const actionTransport = new ActionTransport(actions, (source, subscriberId) => ({ push: (request) => emitFrom(source, subscriberId, request) }), refs, (message) => eventLogger.logDiagnostic({ source: 'ActionTransport', message }));
  const syncDispatcher = new SyncDispatcher(eventLogger, historyLog, actionTransport, refs);
  const startedAt = Date.now();
  const asyncDispatcher = new AsyncDispatcher(
    inFlightWalUpdater(wal),
    async (walEntry, lastError, info) => {
      const dlqEntry: DlqEntry = {
        id: walEntry.id,
        event: walEntry.event,
        payload: walEntry.payload,
        meta: walEntry.meta,
        subscriberId: walEntry.subscriberId,
        attempts: walEntry.attempts,
        lastError,
        movedAt: new Date().toISOString(),
      };
      // Order: (row not there yet) emit, then the DLQ row, then the WAL status. The event is recorded (history and WAL of the subscribers) BEFORE the row exists, so no
      // crash can leave a row without its event: a crash after the emit and before the row leaves the WAL entry 'failed', and running it again (queue retry, or the give-up of
      // a stuck entry) fails again and emits again: a duplicate, never a loss (at-least-once). A row that already exists (a retry after a crash past the append) emits nothing
      // and keeps the mark it has. When the emit does not succeed the row is still written, marked pending with the facts of the event: it is emitted later (see retryPendingAnnouncements).
      const existing = dlq.get(dlqEntry.id);
      let mark: Pick<DlqEntry, 'announce' | 'announceInfo'> = existing?.announce !== undefined ? { announce: existing.announce, ...(existing.announceInfo !== undefined && { announceInfo: existing.announceInfo }) } : {};
      if (existing === undefined) {
        const outcome = await emitDlqEvent(dlqEntry, (entry) => buildDlqAddedEvent(entry, info));
        if (outcome === 'failed') {
          mark = { announce: 'pending', announceInfo: info };
          announceBacklog = true;
        } else if (outcome === 'skipped') {
          mark = { announce: 'skipped', announceInfo: info };
        }
      }
      const appended = dlq.append({ ...dlqEntry, ...mark });
      // The eviction is only known once the row is written: its event follows the write (a crash in between loses that one removed event, the entry is gone either way).
      // The evicted row left the DLQ for good: the WAL entry that carried its payload goes with it.
      if (appended.evicted !== undefined) {
        purgeWalOfDlqRows(wal, [appended.evicted]);
        void emitDlqEvent(appended.evicted, (entry) => buildDlqRemovedEvent(entry, 'evicted'));
      }
      wal.updateEntry(walEntry.id, { status: 'dlq' });
    },
    eventLogger,
    historyLog,
    actionTransport,
    refs,
    (entry, error) => retryNotScheduled(entry, error),
  );

  let activeDispatches = 0;
  // The WAL ids being delivered right now, by any path (push, retry, replay): one entry is never delivered twice at the same time
  const inFlight = new Set<string>();

  /** Runs the delivery of the entries of `subscribers`, marking their ids in flight until it settles. */
  function deliver(subscribers: ResolvedSubscriber[], envelope: EventEnvelope, walEntries: Map<string, WalEntry>): Promise<void> {
    const ids = subscribers.flatMap((sub) => {
      const id = walEntries.get(sub.subscriberId)?.id;
      return id === undefined ? [] : [id];
    });
    for (const id of ids) {
      inFlight.add(id);
    }
    return asyncDispatcher.dispatch(subscribers, envelope, walEntries).finally(() => {
      for (const id of ids) {
        inFlight.delete(id);
      }
    });
  }

  const isStillInFlight = (entry: WalEntry): boolean => entry.status === 'pending' || entry.status === 'failed';

  /**
   * The retry job of an entry could not be created (orch missing, orch failing). The entry is kept retryable and made visible: it becomes 'failed' (so the daemon can idle: only
   * 'pending' entries keep it awake) with the reason and the command to run it by hand in its lastError, which `queue status` and the Pending page show. The cause is said once
   * per daemon run in the log, however many entries hit it. Never throws.
   */
  function retryNotScheduled(entry: WalEntry, error: Error): void {
    try {
      const cause = getErrorMessage(error.cause ?? error).split('\n')[0]!;
      const once = `retry-not-scheduled: ${cause}`;
      if (!saidOnce.has(once)) {
        saidOnce.add(once);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `${getErrorMessage(error).replace(/\s+/g, ' ')} (said once per cause: the other entries that fail the same way carry it in their lastError)` });
      }
      const hint = getErrorMessage(error).includes(`queue retry --event ${entry.id}`) ? '' : ` Once fixed, run it by hand: queue retry --event ${entry.id}`;
      const note = `retry not scheduled: ${getErrorMessage(error).replace(/\s+/g, ' ').slice(0, 400)}${hint}`;
      wal.updateEntryIf(entry.id, isStillInFlight, { status: 'failed', retryDueAt: undefined, lastError: entry.lastError !== undefined ? `${entry.lastError} (${note})` : note });
    } catch (err) {
      eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `${getErrorMessage(error)} (and the entry ${entry.id} could not be marked: ${getErrorMessage(err)})` });
    }
  }
  // Per root event: the hop cap bounds the depth of an action chain, this bounds its width
  const emissionBudget = new EmissionBudget();

  /**
   * The event an action pushes. It is filed under the project (and working directory) of the envelope the subscriber received, never one the plugin
   * names; the hop counter comes from that envelope and is set on the new event by the internal push only. A refusal that would repeat on a retry is permanent.
   */
  async function emitFrom(source: EventEnvelope, subscriberId: string, request: ActionPushRequest): Promise<ActionPushResult> {
    const hops = source.meta.hops ?? 0;
    if (hops >= MAX_ACTION_HOPS) {
      return {
        success: false,
        permanent: true,
        error: `loop guard: the event '${source.event}' was itself emitted by ${hops} actions in a chain (cap ${MAX_ACTION_HOPS}), so '${request.event}' was not emitted. Fix: break the cycle between the action subscribers of subscribers.yml (an action that emits an event another action listens to).`,
      };
    }
    // The queue. namespace is the daemon's own: refused here with a message that names the action, and again by the internal push (which would also refuse it)
    const reserved = reservedEventProblem(request.event, 'an action');
    if (reserved !== undefined) {
      return { success: false, permanent: true, error: reserved };
    }
    // A before* event is dispatched synchronously and answers once: an action has nobody to answer to
    if (request.event.startsWith('before')) {
      return {
        success: false,
        permanent: true,
        error: `an action cannot emit '${request.event}': a 'before*' event is synchronous and answers its pusher. Fix: emit an 'on*' event instead.`,
      };
    }
    // The first push of the chain: carried by the envelope (set by the daemon only), the event itself when a client pushed it
    const rootEventId = source.meta.rootEventId ?? source.meta.eventId ?? source.id;
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
    const reservation = emissionBudget.reserve(rootEventId);
    if (!reservation.granted) {
      const message = `emission budget: the chain started by the event ${rootEventId} has already emitted ${reservation.count} events (cap ${MAX_ACTION_EMISSIONS_PER_ROOT} per chain), so subscriber ${subscriberId} did not emit '${request.event}'. `
        + 'Fix: break the fan-out between the action subscribers of subscribers.yml (several actions that emit an event another action listens to).';
      if (reservation.firstRefusal) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.actions', message });
      }
      return { success: false, permanent: true, error: message };
    }
    const response = await pushInternal(
      {
        event: request.event,
        payload: request.payload,
        ...(source.meta.cwd !== undefined && { cwd: source.meta.cwd }),
        // The registered project of the received envelope (the descendant's for to-children); a virtual project has no folder to find it by
        ...(source.meta.projectId !== undefined && { project: source.meta.projectId }),
      },
      // provenance: the first-push id of the source event and the action subscriber that emitted this one
      { hops: hops + 1, causedBy: { eventId: source.meta.eventId ?? source.id, subscriberId }, rootEventId },
    );
    if (response.status === 'aborted' || response.status === 'rejected') {
      // Only an event that exists counts against the budget
      emissionBudget.release(rootEventId);
    }
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
   * Emits a queue.dlq.* event about a dead-letter entry. Never throws and never rejects: a failure to emit is a diagnostic line, the dispatch path goes on, and the outcome
   * says what happened so the caller can keep the fact (an added event that did not go out is marked on its row, never dropped). The same diagnostic is said once per daemon run.
   * It is filed under the project and working directory of the entry (default direction), carries hops + 1 of the failed dispatch and causedBy it.
   * 'excluded': the base event is itself a queue. event (loop guard), by design. 'skipped': at the hop cap, by design (said in the log, naming the entry).
   * 'failed': the push was aborted or rejected, or threw. Counted in activeDispatches until the push returns, so the daemon does not go idle in between.
   */
  async function emitDlqEvent(entry: DlqEntry, build: (entry: DlqEntry) => BuiltDlqEvent): Promise<DlqEmitOutcome> {
    const source = 'QueueDaemon.dlq-events';
    activeDispatches++;
    let label = `DLQ entry ${entry.id} (event ${entry.event}, subscriber ${entry.subscriberId})`;
    const sayOnce = (message: string): void => {
      if (!saidOnce.has(message)) {
        saidOnce.add(message);
        eventLogger.logDiagnostic({ source, message });
      }
    };
    try {
      if (isDlqEventExcluded(entry)) {
        return 'excluded';
      }
      const built = build(entry);
      label = `${built.event} for ${label}`;
      const hops = entry.meta.hops ?? 0;
      if (hops >= MAX_ACTION_HOPS) {
        sayOnce(`loop guard: ${label} was not emitted: its base event was itself emitted by ${hops} actions or daemon events in a chain (cap ${MAX_ACTION_HOPS}), so the row is marked announce: skipped and is not retried. Fix: break the cycle between the subscribers of subscribers.yml (a subscriber of queue.dlq.* that emits an event which fails again).`);
        return 'skipped';
      }
      const response = await pushInternal(
        {
          event: built.event,
          payload: built.payload,
          ...(entry.meta.cwd !== undefined && { cwd: entry.meta.cwd }),
          ...(entry.meta.projectId !== undefined && { project: entry.meta.projectId }),
        },
        { hops: hops + 1, causedBy: { eventId: entry.meta.eventId ?? entry.id, subscriberId: entry.subscriberId }, origin: 'queue', rootEventId: entry.meta.rootEventId ?? entry.meta.eventId ?? entry.id },
      );
      if (response.status === 'rejected' || response.status === 'aborted') {
        sayOnce(`${label} was not emitted (${response.status}): ${response.reason ?? 'no reason given'}`);
        return 'failed';
      }
      return 'emitted';
    } catch (err) {
      sayOnce(`${label} was not emitted: ${getErrorMessage(err)}`);
      return 'failed';
    } finally {
      activeDispatches--;
    }
  }

  /**
   * Emits queue.dlq.added for a row that is already in the DLQ and keeps its mark true: emitted (or excluded by design) clears it, the hop cap makes it skipped, a failure
   * leaves it pending for the next scan. Never throws: what cannot be written is a diagnostic, and the mark stays as it was (the next scan emits again: a duplicate, never a loss).
   */
  async function announceAdded(row: DlqEntry, info: DlqAddedInfo): Promise<void> {
    try {
      // The event is pushed under the project of the row: once that project is not registered any more the push is refused for good, and a scan after every push would try again for ever
      const projectId = row.meta.projectId;
      if (projectId !== undefined && projectResolver?.lookupId(projectId).kind === 'unregistered') {
        const reason = `the project ${projectId} is not registered any more, so queue.dlq.added cannot be pushed under it`;
        dlq.setAnnounce(row.id, 'unannounceable', reason);
        const message = `DLQ entry ${row.id} (event ${row.event}) is unannounceable: ${reason}. It stays in the dead-letter queue and can still be replayed or cleared; no queue.dlq.added is sent for it`;
        if (!saidOnce.has(message)) {
          saidOnce.add(message);
          eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-events', message });
        }
        return;
      }
      const outcome = await emitDlqEvent(row, (entry) => buildDlqAddedEvent(entry, info));
      if (outcome === 'failed') {
        announceBacklog = true;
        if (row.announce !== 'pending') {
          dlq.setAnnounce(row.id, 'pending');
        }
      } else if (outcome === 'skipped') {
        if (row.announce !== 'skipped') {
          dlq.setAnnounce(row.id, 'skipped');
        }
      } else if (row.announce !== undefined) {
        dlq.setAnnounce(row.id, undefined);
      }
    } catch (err) {
      announceBacklog = true;
      eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-events', message: `queue.dlq.added for DLQ entry ${row.id} (event ${row.event}): the mark of the row could not be updated (${getErrorMessage(err)}); the next scan emits it again` });
    }
  }

  /** added events for rows that just entered the DLQ, at most DLQ_EVENT_BATCH_SIZE pushes at a time. */
  function announceAddedRows(rows: readonly DlqEntry[], info: DlqAddedInfo): Promise<void> {
    activeDispatches++;
    return runBounded(rows, DLQ_EVENT_BATCH_SIZE, (row) => announceAdded(row, info))
      .catch((err: unknown) => {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-events', message: `queue.dlq.added (${info.reason}) batch failed: ${getErrorMessage(err)}` });
      })
      .finally(() => { activeDispatches--; });
  }

  /**
   * Emits the queue.dlq.added of every row still marked pending (the emit failed when the row was written: an invalid subscribers.yml, a refused push). Runs at the start of the
   * daemon and after the next successful push (its configuration loaded); announceBacklog is a flag, no timer keeps the daemon awake. One pass at a time.
   */
  async function retryPendingAnnouncements(): Promise<void> {
    if (announceRetryRunning) {
      return;
    }
    announceRetryRunning = true;
    announceBacklog = false;
    activeDispatches++;
    try {
      const rows = dlq.readAll().filter((row) => row.announce === 'pending');
      await runBounded(rows, DLQ_EVENT_BATCH_SIZE, (row) => announceAdded(row, row.announceInfo ?? { reason: 'retries-exhausted' }));
    } catch (err) {
      announceBacklog = true;
      eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-events', message: `the scan of the pending queue.dlq.added announcements failed: ${getErrorMessage(err)}` });
    } finally {
      announceRetryRunning = false;
      activeDispatches--;
    }
  }

  /** The events of a move the daemon just made itself (a give-up): added for the rows that entered the DLQ, removed(evicted) for the ones the cap pushed out. */
  function announceChanges(changes: DlqChanges): void {
    if (changes.added.length > 0) {
      void announceAddedRows(changes.added, { reason: 'given-up' });
    }
    if (changes.evicted.length > 0) {
      void emitDlqRemoved(changes.evicted, 'evicted');
    }
  }

  /** `removed` events for entries that left the DLQ, at most `DLQ_EVENT_BATCH_SIZE` pushes at a time (a clear can remove a thousand entries). */
  function emitDlqRemoved(entries: readonly DlqEntry[], reason: DlqRemovedReason): Promise<void> {
    // Counted as one unit, so the daemon is not idle between two batches
    activeDispatches++;
    return runBounded(entries, DLQ_EVENT_BATCH_SIZE, async (entry) => { await emitDlqEvent(entry, (e) => buildDlqRemovedEvent(e, reason)); })
      .catch((err: unknown) => {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-events', message: `queue.dlq.removed (${reason}) batch failed: ${getErrorMessage(err)}` });
      })
      .finally(() => { activeDispatches--; });
  }

  /**
   * Records an event and dispatches it. `hops` is how many actions in a chain emitted it: it is given by the daemon's own code only, never by a client
   * (it is not part of PushRequest and is not read from the wire); the RPC push starts every event at 0.
   * `causedBy` is the provenance of an event emitted by an action, given the same way (the RPC push has none).
   * `origin` is `'queue'` for the events the daemon builds about itself, given the same way (never read from the wire, the RPC push has none): it alone
   * allows a name in the reserved `queue.` namespace, and it is required there.
   */
  async function pushInternal(req: PushRequest, internal: { hops: number; causedBy?: CausedBy; origin?: 'queue'; rootEventId?: string; wire?: true }): Promise<PushResponse> {
    // The wire does not check types: a number, an object or an empty name would fail deep inside (HTTP 500) after the history trigger was written
    if (typeof req.event !== 'string' || req.event === '') {
      return { status: 'rejected', reason: `the push has no usable 'event': expected a non-empty string, got ${req.event === '' ? 'an empty string' : JSON.stringify(req.event) ?? typeof req.event}. Fix: send the event name as a string (e.g. 'onTaskDone'); the event was not recorded` };
    }
    // before anything is recorded or counted: a client that speaks a protocol this daemon does not accept gets a loud refusal
    const protocol = checkClientProtocol(req.protocol);
    if (!protocol.ok) {
      return { status: 'rejected', reason: protocol.reason, supported: protocol.supported };
    }
    // Protocol 1.6.0. A request from the wire carries a payload (null is one: absent is a client that forgot it, and the subscribers would render nothing); an action or the daemon itself
    // may emit without one. The size is bounded for every entry: the payload is copied into the WAL of each subscriber and the WAL is rewritten whole on every write.
    if (internal.wire === true && req.payload === undefined) {
      return { status: 'rejected', reason: "the push has no 'payload': the payload is required (any JSON value). Fix: send the data as 'payload', or null when the event carries none; the event was not recorded" };
    }
    if (req.payload !== undefined) {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(req.payload) ?? '');
      } catch (err) {
        return { status: 'rejected', reason: `the payload cannot be written as JSON (${getErrorMessage(err)}); the event was not recorded` };
      }
      const tooBig = payloadSizeProblem(bytes);
      if (tooBig !== undefined) {
        return { status: 'rejected', reason: `${tooBig}; the event was not recorded` };
      }
    }
    // The queue. namespace (protocol 1.5.0) is built by the daemon alone: a client, an action or a replay cannot produce such an event
    if (internal.origin !== 'queue') {
      const reserved = typeof req.event === 'string' ? reservedEventProblem(req.event, 'a push') : undefined;
      if (reserved !== undefined) {
        return { status: 'rejected', reason: `${reserved}; the event was not recorded` };
      }
    } else if (!isReservedEventName(req.event)) {
      return { status: 'rejected', reason: `an event built by the daemon must be named '${RESERVED_EVENT_PREFIX}...', got '${req.event}'; the event was not recorded` };
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
          // A project named by id (an event emitted for a to-children descendant) is that project, whatever folder the event comes from
          projectName: explicit?.kind === 'registered' ? explicit.project.name : cwd !== undefined ? resolveProjectName(cwd) : lookup?.kind === 'registered' ? lookup.project.name : undefined,
          ...(lookup?.kind === 'registered' && { projectId: lookup.project.id }),
          // The id of this first push: the WAL id is one per subscriber (and a `queue replay` is a new push), so an action template renders this one, shared by all the subscribers of the push and kept by a retry and a dlq-replay
          eventId,
          ...(internal.hops > 0 && { hops: internal.hops }),
          ...(internal.rootEventId !== undefined && { rootEventId: internal.rootEventId }),
          ...(internal.origin !== undefined && { origin: internal.origin }),
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
      // The configuration loaded: the moment to emit the queue.dlq.added that could not go out while it did not (not for the daemon's own events, which would recurse)
      if (announceBacklog && !announceRetryRunning && internal.origin !== 'queue') {
        void retryPendingAnnouncements();
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
        ...(internal.causedBy !== undefined && { causedBy: internal.causedBy }),
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
        walEntries.set(sub.subscriberId, {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          event: req.event,
          payload: req.payload,
          meta: envelopeFor(sub).meta,
          subscriberId: sub.subscriberId,
          status: 'pending',
          attempts: 0,
        });
      }
      // One write for all the subscribers: recorded whole or not at all. One write per subscriber could record the first and fail on the second, the caller was told the push
      // failed (a client retries, a duplicate) while the recorded entry was delivered at the next start.
      try {
        wal.appendMany([...walEntries.values()]);
      } catch (err) {
        const reason = getErrorMessage(err);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `event ${req.event} was not recorded: the WAL could not be written (${reason}); nothing was recorded or dispatched` });
        throw new Error(`the event ${req.event} was not recorded: the WAL could not be written (${reason}). Nothing was recorded or dispatched, so pushing it again does not duplicate anything. Fix: check that nothing locks or protects wal.ndjson in the queue config directory (antivirus, read-only attribute) and that the disk has room`, { cause: err });
      }

      // Fire and forget
      const groups = new Map<EventEnvelope, ResolvedSubscriber[]>();
      for (const sub of filtered) {
        const groupEnvelope = envelopeFor(sub);
        groups.set(groupEnvelope, [...(groups.get(groupEnvelope) ?? []), sub]);
      }
      for (const [groupEnvelope, groupSubscribers] of groups) {
        deliver(groupSubscribers, groupEnvelope, walEntries).catch((err: unknown) => {
          eventLogger.logDiagnostic({ source: 'QueueDaemon.push', message: `AsyncDispatcher error for event ${req.event}: ${getErrorMessage(err)}` });
        });
      }

      return { status: 'queued', subscriberCount: filtered.length, eventId: envelope.id };
    } finally {
      activeDispatches--;
    }
}

  /**
   * A diagnostic line per cycle between the action subscribers of the global file and of every registered project. Informational: the runtime hop cap is the guard,
   * and an unreadable file is said, never an abort (the push of an event reports its own configuration error).
   */
  function reportActionCycles(): void {
    const source = 'QueueDaemon.onStart';
    const sources: Array<ProjectConfigSource | undefined> = [undefined];
    try {
      sources.push(...(projectResolver?.allConfigSources() ?? []));
    } catch (err) {
      eventLogger.logDiagnostic({ source, message: `action loop check: only the global subscribers.yml was checked, the project registry could not be read: ${getErrorMessage(err)}` });
    }
    const seen = new Map<string, CycleSubscriber>();
    const chains = new Map<string, string[]>();
    for (const projectSource of sources) {
      try {
        for (const list of configLoader.load(undefined, projectSource).values()) {
          for (const sub of list) {
            seen.set(`${sub.file}\0${sub.event}\0${sub.subscriberId}`, sub);
          }
          reportConfigProblems(list);
        }
        if (projectSource !== undefined) {
          chains.set(projectSource.projectId, projectSource.layers.map((layer) => layer.projectId));
        }
      } catch (err) {
        eventLogger.logDiagnostic({
          source,
          message: `action loop check skipped ${projectSource === undefined ? 'the global subscribers' : `the subscribers of the project ${projectSource.projectId}`}: ${getErrorMessage(err)}`,
        });
      }
    }
    try {
      for (const finding of findActionCycles([...seen.values()], actions, { chains })) {
        eventLogger.logDiagnostic({ source, message: `${finding.severity === 'error' ? 'error' : 'warning'}: ${finding.message}` });
      }
    } catch (err) {
      eventLogger.logDiagnostic({ source, message: `action loop check failed: ${getErrorMessage(err)}` });
    }
  }

  /**
   * Files the events the action plugins emit in the event catalog (source `action-<plugin>`), replacing what the previous run wrote.
   * A declaration that cannot be stored is said in the log; the daemon starts anyway (the catalog is documentation).
   */
  function declareActionEvents(): void {
    for (const plugin of actions.list()) {
      if (plugin.events === undefined || plugin.events.length === 0) {
        continue;
      }
      try {
        const checked = validateSourceDeclaration({ source: `action-${plugin.name}`, events: plugin.events });
        if (!checked.ok) {
          throw new Error(checked.problems.map((problem) => `${problem.path || 'declaration'}: ${problem.message}`).join('; '));
        }
        writeSourceDeclaration(configDir, checked.declaration);
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `could not declare the events of the action '${plugin.name}' in the event catalog: ${getErrorMessage(err)}` });
      }
    }
  }

  /**
   * Files the two `queue.dlq.*` events in the event catalog under the source `queue`, replacing what the previous run wrote. The file is written directly: the
   * source `queue` is closed to `register-events`. A declaration that cannot be stored is said in the log; the daemon starts anyway (the catalog is documentation).
   */
  function declareDaemonEvents(): void {
    try {
      const checked = validateSourceDeclaration({ source: 'queue', events: DLQ_EVENT_DECLARATIONS });
      if (!checked.ok) {
        throw new Error(checked.problems.map((problem) => `${problem.path || 'declaration'}: ${problem.message}`).join('; '));
      }
      writeSourceDeclaration(configDir, checked.declaration);
    } catch (err) {
      eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `could not declare the events of the queue daemon (queue.dlq.added, queue.dlq.removed) in the event catalog: ${getErrorMessage(err)}` });
    }
  }

  /** Hands every pending WAL entry to the retry scheduler; one that cannot be scheduled is marked and reported (see retryNotScheduled). */
  function reschedulePending(sync: boolean): void {
    for (const entry of wal.readAll().filter((candidate) => candidate.status === 'pending')) {
      try {
        // The due time first: the stuck limit counts from it (a pending entry written hours ago is about to be retried, not stuck)
        wal.updateEntryIf(entry.id, isStillInFlight, { retryDueAt: new Date(Date.now() + backoffMinutes(entry.attempts) * 60_000).toISOString() });
        RetryScheduler.scheduleRetry(entry, sync, { onError: (error) => retryNotScheduled(entry, error) });
      } catch (err) {
        retryNotScheduled(entry, err instanceof Error ? err : new Error(getErrorMessage(err)));
      }
    }
  }

  /**
   * A dlq-replay writes the pending WAL entry first and removes the DLQ row second; a crash between the two leaves an entry that will be delivered at the next start AND a row
   * that can be replayed again (a double delivery). Such a row is recognisable: the WAL entry of its id is pending and newer than the row (the mover only ever leaves it failed or dlq).
   * Runs at the start; the row is removed and its queue.dlq.removed (replayed) is sent.
   */
  function dropReplayedRows(): void {
    try {
      const byId = new Map(wal.readAll().map((candidate) => [candidate.id, candidate]));
      const stale = dlq.readAll().filter((row) => {
        const walEntry = byId.get(row.id);
        return walEntry !== undefined && walEntry.status === 'pending' && Date.parse(walEntry.timestamp) >= Date.parse(row.movedAt);
      });
      if (stale.length === 0) {
        return;
      }
      const removed = dlq.removeEntries(stale.map((row) => row.id));
      eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `removed ${removed.length} DLQ row(s) (${removed.map((row) => row.id).join(', ')}) whose replay had started before the last stop: the WAL entry is pending and is delivered once, the row would have allowed a second delivery` });
      void emitDlqRemoved(removed, 'replayed');
    } catch (err) {
      eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `could not check the DLQ rows of interrupted replays: ${getErrorMessage(err)}` });
    }
  }

  const commands: QueueCommands = {
    async push(payload?: unknown): Promise<PushResponse> {
      options.onActivity?.();
      return pushInternal(payload as PushRequest, { hops: 0, wire: true });
    },

    async retry(payload?: unknown): Promise<RetryResponse> {
      const req = payload as RetryRequest;
      const entries = wal.readAll();
      const entry = entries.find(e => e.id === req.eventId);
      if (!entry) {
        return { status: 'not-found' };
      }
      // A delivered entry would run its subscriber a second time; a DLQ entry has its own row there and a retry would run it behind its back
      if (entry.status === 'acked') {
        return { status: 'error', message: `WAL entry ${entry.id} was already delivered (status acked): retrying it would run ${entry.subscriberId} a second time. To run the event again, use 'queue replay <eventId>' with the eventId of the original push (see 'queue history').` };
      }
      if (entry.status === 'dlq') {
        return { status: 'error', message: `WAL entry ${entry.id} was given up and sits in the dead-letter queue: retrying it from the WAL would duplicate it. Use 'queue dlq replay --id ${entry.id}' to run it again, or 'queue dlq clear --id ${entry.id}' to drop it.` };
      }

      // A delivery of this entry is running: a second one would run the subscriber twice at the same time (a retry job scheduled twice, a retry while the first run is slow)
      if (inFlight.has(entry.id)) {
        return { status: 'error', message: `WAL entry ${entry.id} is being delivered right now: running it again at the same time would run ${entry.subscriberId} twice. Wait for that delivery to end; if it fails it is retried on its own, or run 'queue retry --event ${entry.id}' again afterwards.` };
      }

      const cwd = entry.meta.cwd;
      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = loadSubscribers(entry.event, cwd, undefined, entry.meta.projectId);
      } catch (err) {
        const reason = getErrorMessage(err);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.retry', message: `config error for event ${entry.event}: ${reason}` });
        return { status: 'error', message: `WAL entry ${entry.id} was not retried: the configuration for event ${entry.event} does not load (${reason}). Fix: repair subscribers.yml, then retry again (queue retry --event ${entry.id}).` };
      }
      const sub = findSubscriber(subscribers, entry.subscriberId);
      if (!sub) {
        eventLogger.logDiagnostic({
          source: 'QueueDaemon.retry',
          message: `subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}; WAL entry ${entry.id} cannot be retried`,
        });
        return { status: 'error', message: `WAL entry ${entry.id} was not retried: the subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}. Fix: restore that subscriber and retry again (queue retry --event ${entry.id}), or give the entry up from the Pending page of the dashboard.` };
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
      deliver([sub], envelope, walEntries).catch((err: unknown) => {
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
      reportConfigProblems(subscribers);
      return {
        subscribers: subscribers.map((sub) => {
          const problem = sub.configProblem ?? sub.cwdProblem;
          return problem === undefined ? sub : { ...sub, problem };
        }),
      };
    },

    'dlq-list'(): DlqListResponse {
      return { entries: dlq.readAll() };
    },

    /**
     * Order: resolve the subscriber FIRST. A replay that cannot run (the configuration does not load, the subscriber was renamed) answers an error with what to fix and leaves the
     * DLQ and the WAL untouched, so the entry is still there once the cause is fixed. Only then the WAL entry is re-created under the same id (one entry per id), the row is
     * removed, and the dispatch starts only if this call is the one that removed the row (a concurrent clear that won makes the replay refuse, not run anyway).
     */
    async 'dlq-replay'(payload?: unknown): Promise<DlqReplayResponse> {
      const req = payload as DlqReplayRequest;
      const entry = dlq.get(req.id);
      if (!entry) {
        return { status: 'not-found' };
      }

      let subscribers: ResolvedSubscriber[];
      try {
        subscribers = loadSubscribers(entry.event, entry.meta.cwd, undefined, entry.meta.projectId);
      } catch (err) {
        const reason = getErrorMessage(err);
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `config error for event ${entry.event}: ${reason}` });
        return { status: 'error', message: `The replay of DLQ entry ${entry.id} did not start: the configuration for event ${entry.event} does not load (${reason}). The entry is still in the dead-letter queue. Fix: repair subscribers.yml, then replay it again (queue dlq replay --id ${entry.id})` };
      }
      const sub = findSubscriber(subscribers, entry.subscriberId);
      if (!sub) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}; DLQ entry ${entry.id} was not replayed` });
        return { status: 'error', message: `The replay of DLQ entry ${entry.id} did not start: the subscriber ${entry.subscriberId} no longer exists in subscribers.yml for event ${entry.event}. The entry is still in the dead-letter queue. Fix: restore that subscriber and replay it again (queue dlq replay --id ${entry.id}), or drop the entry (queue dlq clear --id ${entry.id})` };
      }

      if (inFlight.has(entry.id)) {
        return { status: 'error', message: `The replay of DLQ entry ${entry.id} did not start: that entry is being delivered right now, replaying it would run ${entry.subscriberId} twice at the same time. The entry is still in the dead-letter queue. Fix: wait for the delivery to end, then replay it again if it is still needed (queue dlq replay --id ${entry.id})` };
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
      const previous = wal.readAll().find((candidate) => candidate.id === entry.id);
      // Replaces the WAL entry the give-up left in status dlq: the id is in the WAL once, so a retry or a give-up finds the delivery that is running
      wal.upsert(walEntry);
      // The entry as stored at the moment of the removal: what the removed event is about. Empty when someone else removed it since the read (that remover emits)
      let removed: DlqEntry[];
      try {
        removed = dlq.removeEntries(entry.id);
      } catch (err) {
        // The row is still there: the WAL entry goes back to what it was, or the entry would be delivered by its pending status AND replayable from the row. (A crash right here is
        // repaired at the next start: a pending entry newer than its row means a replay began, see dropReplayedRows.)
        const reason = getErrorMessage(err);
        try {
          if (previous !== undefined) {
            wal.upsert(previous);
          } else {
            wal.removeWhere((candidate) => candidate.id === walEntry.id && candidate.status === 'pending' && candidate.timestamp === walEntry.timestamp);
          }
        } catch (undoErr) {
          eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `replay of DLQ entry ${entry.id}: the WAL entry could not be put back (${getErrorMessage(undoErr)}); it stays pending and the row stays in the DLQ, the next start removes the row` });
        }
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `replay of DLQ entry ${entry.id}: the row could not be removed (${reason}); nothing was run` });
        return { status: 'error', message: `The replay of DLQ entry ${entry.id} did not start: the row could not be removed from the dead-letter queue (${reason}), so nothing was run and the entry is still in the dead-letter queue. Fix: check that nothing locks dlq.ndjson in the queue config directory, then replay it again (queue dlq replay --id ${entry.id})` };
      }
      if (removed.length !== 1) {
        // Undo the re-creation (only the entry this call wrote): the row is gone, a clear removed it on purpose
        wal.removeWhere((candidate) => candidate.id === walEntry.id && candidate.status === 'pending' && candidate.timestamp === walEntry.timestamp);
        return { status: 'error', message: `DLQ entry ${entry.id} was removed from the dead-letter queue by another operation (a clear?) while the replay started, so nothing was run` };
      }

      const envelope: EventEnvelope = {
        id: walEntry.id,
        timestamp: walEntry.timestamp,
        event: walEntry.event,
        payload: walEntry.payload,
        meta: walEntry.meta,
      };
      const walEntries = new Map([[sub.subscriberId, walEntry]]);
      deliver([sub], envelope, walEntries).catch((err: unknown) => {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.dlq-replay', message: `replay dispatch error for ${entry.subscriberId} (WAL ${walEntry.id}): ${getErrorMessage(err)}` });
      });
      // The dispatch has started (the call above runs up to its first await): only now is the entry really replayed
      void emitDlqRemoved(removed, 'replayed');

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
      // The daemon declares its own events in source 'queue' by writing the file itself; no client may claim that source or a queue. event name
      if (checked.declaration.source === 'queue') {
        return { status: 'rejected', reason: `the source 'queue' is reserved for the events the queue daemon declares itself, so a client cannot register it. Fix: register your events under your own source name (the name of your program).` };
      }
      const reservedEvent = checked.declaration.events.find((declared) => isReservedEventName(declared.name));
      if (reservedEvent !== undefined) {
        return { status: 'rejected', reason: `events[${checked.declaration.events.indexOf(reservedEvent)}].name: ${reservedEventProblem(reservedEvent.name, `the source '${checked.declaration.source}'`)}` };
      }
      writeSourceDeclaration(configDir, checked.declaration);
      return { status: 'registered', source: checked.declaration.source, count: checked.declaration.events.length };
    },

    'dlq-clear'(payload?: unknown): DlqClearResponse {
      const req = payload as DlqClearRequest | undefined;
      // No id at all clears everything; an id that is not a non-empty string (a client that lost the value) clears nothing and says so
      if (req?.id !== undefined && (typeof req.id !== 'string' || req.id === '')) {
        return { cleared: 0, reason: `dlq-clear needs the id of one entry as { id: '<id>' } (a non-empty string), or no id to clear the whole DLQ; got ${JSON.stringify(req.id)}. Fix: send the id shown by the DLQ list, or omit the id to clear everything; nothing was cleared` };
      }
      const removed = removeDlqEntries(dlq, wal, req?.id);
      // After the clear returned: the events are pushed in the background, the answer does not wait for them
      void emitDlqRemoved(removed, 'cleared');
      return { cleared: removed.length };
    },

    /**
     * Gives up one in-flight event: the daemon moves it to the DLQ itself (a compare-and-set on the WAL) and emits queue.dlq.added from the row it moved. The request carries
     * the id and nothing else is read from it: a client cannot choose an event, a subscriber, a project, a reference or a hop count. The row is written marked pending, so a
     * crash before the emit leaves the event to be sent at the next start.
     */
    'give-up'(payload?: unknown): GiveUpResponse {
      const id = (payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || id === '') {
        return { status: 'rejected', reason: "give-up needs the WAL id of the event as { id: '<id>' } (a non-empty string). Fix: send the id shown by the pending list (queue status, the Pending page); nothing was moved" };
      }
      const result = abandonInFlightEntryDetailed(configDir, id, new Date(), { markAnnouncePending: true });
      if (result.status !== 'moved') {
        return { status: result.status };
      }
      announceChanges(result.changes);
      return { status: 'moved' };
    },

    /** Gives up every in-flight event older than the stuck limit (STUCK_AFTER_MS, not a client's choice), one queue.dlq.added per moved row. The body is not read. */
    'give-up-stuck'(): GiveUpStuckResponse {
      const { moved, changes } = abandonStuckEntriesDetailed(configDir, { markAnnouncePending: true });
      announceChanges(changes);
      return { moved };
    },
  };

  return {
    commands,
    eventLogger,
    pushDaemonEvent: (request, options = {}) => pushInternal(request, { hops: options.hops ?? 0, ...(options.causedBy !== undefined && { causedBy: options.causedBy }), origin: 'queue' }),
    // The acknowledgements that could not be written when a delivery ended are written again here (the host asks every few seconds): a delivered entry left pending keeps the daemon awake
    isIdle: () => asyncDispatcher.retryUnrecorded() === 0 && wal.pendingCount() === 0 && activeDispatches === 0,
    onStart: () => {
      declareDaemonEvents();
      declareActionEvents();
      reportActionCycles();
      // The programs of cli subscribers are looked up in the PATH this daemon inherited when it started: say which one, so that "program not found" is diagnosable
      eventLogger.logDiagnostic({
        source: 'QueueDaemon.onStart',
        message: `programs of cli subscribers are looked up in the PATH this daemon was started with (${describeSearchPath(process.env, 40)}); a daemon started from a reduced environment cannot find tools of the npm global directory: restart it from a shell where they work ("queue stop", the next push starts it again)`,
      });
      // What the WAL keeps of rows that already left the DLQ (cleared before the WAL was purged with them): the payload must not stay for ever
      try {
        const { pruned } = pruneOrphanedDlqWalEntries(configDir, { onDiagnostic: (diagnostic) => eventLogger.logDiagnostic(diagnostic) });
        if (pruned > 0) {
          eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `removed ${pruned} WAL ${pruned === 1 ? 'entry' : 'entries'} in status dlq that no dead-letter queue row refers to (older than a day)` });
        }
      } catch (err) {
        eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `could not prune the WAL entries of cleared dead-letter rows: ${getErrorMessage(err)}` });
      }
      // The queue.dlq.added that could not go out before the last stop (mark pending) is emitted now, or after the next successful push if the configuration does not load yet
      void retryPendingAnnouncements();
      dropReplayedRows();
      // Startup scan: reschedule pending WAL entries
      reschedulePending(false);
    },
    onShutdown: () => {
      // A delivered entry whose acknowledgement is still waiting must not be rescheduled: one more try to write it
      asyncDispatcher.retryUnrecorded();
      // Shutdown scan: sync reschedule
      reschedulePending(true);
    },
  };
}
