import type { DlqEntry } from '../storage/DlqStore.js';
import type { CatalogProblem } from '../catalog/EventCatalog.js';
import type { ResolvedSubscriber } from '../types.js';

// The RPC contract between the queue daemon and its clients (queue-cli, app-module-queue,
// queue-relay-client). Types only: nothing here depends on how the daemon is hosted.

// `protocol` is the SemVer push protocol the client speaks (absent = 1.0.0); see @wadeck-app/queue-sdk/protocol
// `project` (protocol 1.2.0): the id of a project of the project-sdk registry, resolved by the client; the daemon only checks it is registered
export interface PushRequest { event: string; payload: unknown; timeout?: number; cwd?: string; replayOf?: string; protocol?: string; project?: string; direction?: unknown; }
// `rejected`: the push was not recorded because the client protocol is not accepted; `supported` is the range of accepted client versions
export interface PushResponse { status: 'dispatched' | 'queued' | 'aborted' | 'rejected'; result?: unknown; reason?: string; subscriberCount?: number; eventId?: string; supported?: string; }
// Protocol 1.1.0: a program declares the events it pushes (see catalog/EventCatalog.ts). `events` is validated by the daemon.
export interface RegisterEventsRequest { protocol?: string; source: string; events: unknown[]; }
export interface RegisterEventsResponse { status: 'registered' | 'rejected'; source?: string; count?: number; reason?: string; problems?: CatalogProblem[]; supported?: string; }
export interface RetryRequest { eventId: string; }
// `message`: why a retry was refused (the entry is already delivered or sits in the DLQ), with what to do instead
export interface RetryResponse { status: 'ok' | 'not-found' | 'error'; message?: string; }
export interface StatusResponse { pendingCount: number; dlqCount: number; daemonRunning: true; uptimeSec: number; pid: number; }
export interface ListSubscribersRequest { event?: string; cwd: string; }
export interface SubscriberListResponse { subscribers: ResolvedSubscriber[]; }
export interface DlqListResponse { entries: DlqEntry[]; }
export interface DlqReplayRequest { id: string; }
// `error`: the replay did not start and the entry is still in the dead-letter queue; `message` says why and what to fix (an unreadable subscribers.yml, a subscriber that was renamed)
export interface DlqReplayResponse { status: 'ok' | 'not-found' | 'error'; message?: string; }
export interface DlqClearRequest { id?: string; }
export interface DlqClearResponse { cleared: number; }
// `give-up` / `give-up-stuck`: the daemon runs the move of an event that nobody retries any more to the DLQ ITSELF and emits the `queue.dlq.*` events from the rows it moved.
// The requests carry an id (give-up) or nothing (give-up-stuck): no client supplies the data an event is built from, whatever else a request body contains is ignored.
export interface GiveUpRequest { id: string; }
// `moved`: the entry is in the DLQ now (its queue.dlq.added is emitted in the background). `rejected`: no usable id; `reason` says what to send.
export interface GiveUpResponse { status: 'moved' | 'not-found' | 'not-in-flight' | 'rejected'; reason?: string; }
export interface GiveUpStuckResponse { moved: number; }

export type QueueCommands = {
  push: (payload?: unknown) => Promise<PushResponse>;
  'register-events': (payload?: unknown) => RegisterEventsResponse;
  retry: (payload?: unknown) => Promise<RetryResponse>;
  status: (payload?: unknown) => StatusResponse;
  'list-subscribers': (payload?: unknown) => Promise<SubscriberListResponse>;
  'dlq-list': (payload?: unknown) => DlqListResponse;
  'dlq-replay': (payload?: unknown) => Promise<DlqReplayResponse>;
  'dlq-clear': (payload?: unknown) => DlqClearResponse;
  'give-up': (payload?: unknown) => GiveUpResponse;
  'give-up-stuck': (payload?: unknown) => GiveUpStuckResponse;
};
