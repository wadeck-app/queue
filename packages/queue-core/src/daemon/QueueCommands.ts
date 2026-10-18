import type { DlqEntry } from '../storage/DlqStore.js';
import type { ResolvedSubscriber } from '../types.js';

// The RPC contract between the queue daemon and its clients (queue-cli, app-module-queue,
// queue-relay-client). Types only: nothing here depends on how the daemon is hosted.

export interface PushRequest { event: string; payload: unknown; timeout?: number; cwd: string; replayOf?: string; }
export interface PushResponse { status: 'dispatched' | 'queued' | 'aborted'; result?: unknown; reason?: string; subscriberCount?: number; eventId?: string; }
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
