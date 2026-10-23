import type { DlqEntry } from '../storage/DlqStore.js';
import type { ResolvedSubscriber } from '../types.js';

// The RPC contract between the queue daemon and its clients (queue-cli, app-module-queue,
// queue-relay-client). Types only: nothing here depends on how the daemon is hosted.

// `protocol` is the SemVer push protocol the client speaks (absent = 1.0.0); see @wadeck-app/queue-sdk/protocol
export interface PushRequest { event: string; payload: unknown; timeout?: number; cwd: string; replayOf?: string; protocol?: string; }
// `rejected`: the push was not recorded because the client protocol is not accepted; `supported` is the range of accepted client versions
export interface PushResponse { status: 'dispatched' | 'queued' | 'aborted' | 'rejected'; result?: unknown; reason?: string; subscriberCount?: number; eventId?: string; supported?: string; }
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
