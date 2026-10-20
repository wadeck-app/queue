import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError, RelayNotConfiguredError } from './errors.js';
import { RelayApiError } from '@wadeck-app/queue-relay-client/dist/relayApi.js';

const {
  mockGetStatus,
  mockGetActivity,
  mockGetActivitySeries,
  mockGetOutcomes,
  mockGetBreakdown,
  mockListPending,
  mockListHistory,
  mockGetHistoryEntry,
  mockReplayEvent,
  mockListDlq,
  mockReplayDlqEntry,
  mockClearDlqEntry,
  mockListSubscribers,
  mockPushEvent,
  mockGetLogs,
  mockRetryEvent,
  mockGetDaemonState,
  mockGetRelayInfo,
  mockListWebhooks,
  mockListDeliveries,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockGetActivity: vi.fn(),
  mockGetActivitySeries: vi.fn(),
  mockGetOutcomes: vi.fn(),
  mockGetBreakdown: vi.fn(),
  mockListPending: vi.fn(),
  mockListHistory: vi.fn(),
  mockGetHistoryEntry: vi.fn(),
  mockReplayEvent: vi.fn(),
  mockListDlq: vi.fn(),
  mockReplayDlqEntry: vi.fn(),
  mockClearDlqEntry: vi.fn(),
  mockListSubscribers: vi.fn(),
  mockPushEvent: vi.fn(),
  mockGetLogs: vi.fn(),
  mockRetryEvent: vi.fn(),
  mockGetDaemonState: vi.fn(),
  mockGetRelayInfo: vi.fn(),
  mockListWebhooks: vi.fn(),
  mockListDeliveries: vi.fn(),
}));

vi.mock('./status.js', () => ({ getStatus: mockGetStatus }));
vi.mock('./activity.js', () => ({ getActivity: mockGetActivity, getActivitySeries: mockGetActivitySeries }));
vi.mock('./outcomes.js', () => ({ getOutcomes: mockGetOutcomes }));
vi.mock('./breakdown.js', () => ({ getBreakdown: mockGetBreakdown }));
vi.mock('./pending.js', () => ({ listPending: mockListPending }));
vi.mock('./history.js', () => ({ listHistory: mockListHistory, getHistoryEntry: mockGetHistoryEntry }));
vi.mock('./replay.js', () => ({ replayEvent: mockReplayEvent }));
vi.mock('./dlq.js', () => ({ listDlq: mockListDlq, replayDlqEntry: mockReplayDlqEntry, clearDlqEntry: mockClearDlqEntry }));
vi.mock('./subscribers.js', () => ({ listSubscribers: mockListSubscribers }));
vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));
vi.mock('./logs.js', () => ({ getLogs: mockGetLogs }));
vi.mock('./retry.js', () => ({ retryEvent: mockRetryEvent }));
vi.mock('./daemon.js', () => ({ getDaemonState: mockGetDaemonState }));
vi.mock('./relay.js', () => ({ getRelayInfo: mockGetRelayInfo }));
vi.mock('./relayWebhooks.js', () => ({ listWebhooks: mockListWebhooks, listDeliveries: mockListDeliveries }));

import backend from './index.js';

// backend.ts narrows req to just the shape it reads (params/query/body) via its own cast;
// a real FastifyRequest has 25+ properties we don't need to fake for these unit tests.
function fakeReq(partial: Record<string, unknown> = {}): Parameters<ModuleRouteHandler>[0] {
  return partial as unknown as Parameters<ModuleRouteHandler>[0];
}

// Same rationale as fakeReq: backend.ts only calls reply.code(n).send(body).
function fakeReply() {
  const send = vi.fn((body: unknown) => body);
  const code = vi.fn((_status: number) => ({ send }));
  return { code, send };
}

function asReply(reply: ReturnType<typeof fakeReply>): Parameters<ModuleRouteHandler>[1] {
  return reply as unknown as Parameters<ModuleRouteHandler>[1];
}

function collectRoutes(): { routes: Map<string, ModuleRouteHandler>; ctx: ModuleContext } {
  const routes = new Map<string, ModuleRouteHandler>();
  const ctx: ModuleContext = {
    dataDir: '/unused/data-dir',
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    registerRoute: (method, subPath, handler) => routes.set(`${method} ${subPath}`, handler),
    dispose: vi.fn(),
  };
  return { routes, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backend', () => {
  it('registers one route per app-module-queue operation', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    expect([...routes.keys()]).toEqual([
      'GET /status',
      'GET /activity',
      'GET /activity/series',
      'GET /outcomes',
      'GET /breakdown',
      'GET /history',
      'GET /history/:eventId',
      'POST /history/:eventId/replay',
      'GET /logs',
      'POST /retry/:eventId',
      'GET /daemon',
      'GET /relay',
      'GET /relay/webhooks',
      'GET /relay/deliveries',
      'GET /pending',
      'GET /dlq',
      'POST /dlq/:id/replay',
      'POST /dlq/:id/clear',
      'GET /subscribers',
      'POST /push',
    ]);
  });

  it('GET /status forwards getStatus()', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetStatus.mockReturnValue({ pendingCount: 1, dlqCount: 0 });
    const reply = fakeReply();
    await routes.get('GET /status')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ pendingCount: 1, dlqCount: 0 });
  });

  it('GET /activity forwards the event counts of the last 5 min, 60 min and 24 h', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivity.mockReturnValue({ last5Min: 2, last60Min: 9, last24Hours: 140 });
    const reply = fakeReply();
    routes.get('GET /activity')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ last5Min: 2, last60Min: 9, last24Hours: 140 });
  });

  it('GET /activity returns 500 with the reason when the history cannot be read', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivity.mockImplementation(() => { throw new Error('Cannot read history'); });
    const reply = fakeReply();
    routes.get('GET /activity')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Cannot read history' });
  });

  it('GET /history forwards limit/offset query params and sends the full page', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 10 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '5', offset: '10' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: undefined, subscriberId: undefined }),
      { limit: 5, offset: 10 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 10 });
  });

  it('GET /history omits limit/offset when not provided, letting listHistory default them', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 0, limit: 20, offset: 0 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: {} }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(expect.any(String), expect.anything(), { limit: undefined, offset: undefined });
  });

  it('GET /history returns 400 when limit is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "abc"',
    });
  });

  it('GET /history returns 400 when limit is 0', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '0' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "0"',
    });
  });

  it('GET /history returns 400 when limit exceeds MAX_HISTORY_LIMIT (501)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '501' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "501"',
    });
  });

  it('GET /history returns 400 when offset is negative', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { offset: '-3' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'offset must be an integer >= 0, got: "-3"',
    });
  });

  it('GET /history returns 400 when sinceMs is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be an integer >= 0, got: "abc"',
    });
  });

  it('GET /history returns 400 when sinceMs is decimal', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: '1000.5' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be an integer >= 0, got: "1000.5"',
    });
  });

  it('GET /history returns 400 when limit is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: ['5', '10'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when offset is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { offset: ['0', '10'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'offset must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when sinceMs is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: ['1000', '2000'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when status is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { status: ['success', 'failed'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'status must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when status is invalid', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { status: 'bogus' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'status must be one of success, failed, dlq, filtered, got: "bogus"',
    });
  });

  it('GET /history returns 200 with valid page when query params are valid', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 10 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '5', offset: '10', status: 'success' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 10 });
  });

  it('GET /history accepts page=0 with limit, passes page to listHistory', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 0 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '0', limit: '5' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { limit: 5, offset: undefined, page: 0 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 0 });
  });

  it('GET /history accepts page=1 with limit, passes page to listHistory', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 5 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '1', limit: '5' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { limit: 5, offset: undefined, page: 1 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 5 });
  });

  it('GET /history returns 400 when page is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: "abc"',
    });
  });

  it('GET /history returns 400 when page is negative', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '-1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: "-1"',
    });
  });

  it('GET /history returns 400 when page is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: ['0', '1'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when both page and offset are given', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '1', offset: '5' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page and offset cannot be combined: use page (with limit) or offset, not both',
    });
  });

  it('GET /history returns 400 when page * limit overflows safe integer', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    const maxSafeInt = '9007199254740991';
    routes.get('GET /history')!(fakeReq({ query: { page: maxSafeInt, limit: '100' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: `page * limit must be a safe integer, got page="${maxSafeInt}" limit="100"`,
    });
  });

  it('GET /history returns 400 when page is empty string', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: ""',
    });
  });

  it('POST /history/:eventId/replay returns 404 when eventId is not found', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new ReplayNotFoundError('No history entry found for eventId x'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: 'No history entry found for eventId x' });
  });

  it('POST /history/:eventId/replay returns 422 when entry has no recorded payload', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new ReplayError('No payload recorded for eventId x'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith({ error: 'No payload recorded for eventId x' });
  });

  it('POST /history/:eventId/replay returns 503 when daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new DaemonUnreachableError('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Daemon is not running' });
  });

  it('POST /history/:eventId/replay returns 500 for other errors', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new Error('Unexpected error'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected error' });
  });

  it('GET /dlq answers the entries', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const entry = { id: 'd 1', event: 'onFoo', subscriberId: 'onFoo[0]', payload: {}, meta: {}, attempts: 5, lastError: 'x', movedAt: '2026-10-19T10:00:00.000Z' };
    mockListDlq.mockReturnValue([entry]);
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [entry] });
  });

  it('GET /dlq returns 500 with the reason when reading the DLQ fails (the daemon is not involved)', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDlq.mockImplementation(() => { throw new Error('Cannot read dlq.ndjson'); });
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Cannot read dlq.ndjson' });
  });

  it('GET /subscribers returns 500 with the reason for an invalid subscribers.yml', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockImplementation(() => { throw new Error('Invalid subscribers.yml: bad indentation'); });
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: '/p' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid subscribers.yml: bad indentation' });
  });

  it('POST /dlq/:id/clear returns 500 with the reason when the DLQ cannot be edited', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockClearDlqEntry.mockImplementation(() => { throw new Error('Lock held by another process'); });
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/clear')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Lock held by another process' });
  });

  it('POST /dlq/:id/replay answers 500, not 503, for an error that is not about the daemon', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayDlqEntry.mockRejectedValue(new Error('Unexpected failure'));
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/replay')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected failure' });
  });

  it('POST /dlq/:id/replay still answers 503 when the daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayDlqEntry.mockRejectedValue(new DaemonUnreachableError('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/replay')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('GET /activity/series answers the series, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivitySeries.mockReturnValueOnce({ lastHour: [{ label: '12:00', events: 1 }], lastDay: [] });
    const ok = fakeReply();
    await routes.get('GET /activity/series')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ lastHour: [{ label: '12:00', events: 1 }], lastDay: [] });

    mockGetActivitySeries.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /activity/series')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /outcomes answers how the dispatches ended, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const outcomes = { last24Hours: { delivered: 3, failedAttempts: 1, givenUp: 0 }, series: [] };
    mockGetOutcomes.mockReturnValueOnce(outcomes);
    const ok = fakeReply();
    await routes.get('GET /outcomes')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(outcomes);

    mockGetOutcomes.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /outcomes')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /breakdown answers the top events and subscribers, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const breakdown = { topEvents: [{ event: 'onFoo', count: 2 }], otherEvents: 0, subscribers: [] };
    mockGetBreakdown.mockReturnValueOnce(breakdown);
    const ok = fakeReply();
    await routes.get('GET /breakdown')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(breakdown);

    mockGetBreakdown.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /breakdown')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /pending answers the in-flight events with the retry choices, and 500 with the reason when the WAL cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListPending.mockReturnValueOnce({ entries: [], awaitingRetry: 0, options: [] });
    const ok = fakeReply();
    await routes.get('GET /pending')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ entries: [], awaitingRetry: 0, options: [] });

    mockListPending.mockImplementationOnce(() => { throw new Error('EACCES: wal.ndjson'); });
    const broken = fakeReply();
    await routes.get('GET /pending')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: wal.ndjson' });
  });

  it('GET /logs forwards the query to getLogs', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetLogs.mockReturnValue({ date: '2026-10-18', present: true, omitted: 0, lines: [{ text: 'x' }] });
    const reply = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: { limit: '5', date: '2026-10-18' } }), asReply(reply));
    expect(mockGetLogs).toHaveBeenCalledWith(expect.any(String), { limit: '5', date: '2026-10-18' });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ date: '2026-10-18', present: true, omitted: 0, lines: [{ text: 'x' }] });
  });

  it('GET /logs answers 400 for a bad query and 500 for any other failure', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetLogs.mockImplementationOnce(() => { throw new InvalidQueryError('date must be a day as YYYY-MM-DD, got: "x"'); });
    const bad = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: { date: 'x' } }), asReply(bad));
    expect(bad.code).toHaveBeenCalledWith(400);
    expect(bad.send).toHaveBeenCalledWith({ error: 'date must be a day as YYYY-MM-DD, got: "x"' });

    mockGetLogs.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });
    const broken = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: {} }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
  });

  it('GET /daemon answers the daemon state', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetDaemonState.mockResolvedValue({ running: false, hint: 'start it' });
    const reply = fakeReply();
    await routes.get('GET /daemon')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ running: false, hint: 'start it' });
  });

  it('GET /daemon answers 500 with the reason when the check itself fails', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetDaemonState.mockRejectedValue(new Error('unexpected'));
    const reply = fakeReply();
    await routes.get('GET /daemon')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'unexpected' });
  });

  it('GET /relay answers the relay state, and 500 with the reason when it cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetRelayInfo.mockResolvedValueOnce({ state: 'stopped', running: false, connected: false, pid: null, uptimeSec: null, lastError: null });
    const ok = fakeReply();
    await routes.get('GET /relay')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped' }));

    mockGetRelayInfo.mockRejectedValueOnce(new Error('relay answered garbage'));
    const broken = fakeReply();
    await routes.get('GET /relay')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'relay answered garbage' });
  });

  it('GET /relay/webhooks and /relay/deliveries answer what the remote relay says', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListWebhooks.mockResolvedValueOnce({ webhooks: [] });
    const webhooks = fakeReply();
    await routes.get('GET /relay/webhooks')!(fakeReq(), asReply(webhooks));
    expect(webhooks.code).toHaveBeenCalledWith(200);
    expect(webhooks.send).toHaveBeenCalledWith({ webhooks: [] });

    mockListDeliveries.mockResolvedValueOnce({ deliveries: [] });
    const deliveries = fakeReply();
    await routes.get('GET /relay/deliveries')!(fakeReq({ query: { limit: '5', status: 'rejected' } }), asReply(deliveries));
    expect(mockListDeliveries).toHaveBeenCalledWith(expect.any(String), { limit: '5', status: 'rejected' });
    expect(deliveries.code).toHaveBeenCalledWith(200);
  });

  it.each([
    ['a bad query', new InvalidQueryError('limit must be an integer between 1 and 200, got: "0"'), 400],
    ['a relay that is not configured here', new RelayNotConfiguredError('No relay.yml in /cfg.'), 503],
    ['a remote relay that refuses or fails', new RelayApiError('The relay refused the token', 401, 'unauthorized'), 502],
    ['anything else', new Error('boom'), 500],
  ])('GET /relay/deliveries answers the right status for %s', async (_name, error, status) => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDeliveries.mockRejectedValueOnce(error);
    const reply = fakeReply();
    await routes.get('GET /relay/deliveries')!(fakeReq({ query: {} }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(status);
    expect(reply.send).toHaveBeenCalledWith({ error: getErrorMessage(error) });
  });

  it('GET /relay/webhooks uses the same status mapping', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListWebhooks.mockRejectedValueOnce(new RelayNotConfiguredError('No relay.yml in /cfg.'));
    const reply = fakeReply();
    await routes.get('GET /relay/webhooks')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('POST /retry/:eventId answers 200 with the daemon answer when the retry was enqueued', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValue({ status: 'ok' });
    const reply = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(reply));
    expect(mockRetryEvent).toHaveBeenCalledWith(expect.any(String), 'wal-1');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('POST /retry/:eventId answers 404 naming the cause when the event is not pending', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValue({ status: 'not-found' });
    const reply = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'gone' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: expect.stringContaining('No pending event with id gone') });
  });

  it('POST /retry/:eventId answers 500 when the daemon reports an error, 503 when it is not running', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValueOnce({ status: 'error' });
    const failed = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(failed));
    expect(failed.code).toHaveBeenCalledWith(500);

    mockRetryEvent.mockRejectedValueOnce(new DaemonUnreachableError('Daemon is not running -- start it with `queue start`'));
    const down = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(down));
    expect(down.code).toHaveBeenCalledWith(503);
  });

  it('GET /status returns 500 when getStatus throws', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetStatus.mockImplementation(() => { throw new Error('Disk read error'); });
    const reply = fakeReply();
    await routes.get('GET /status')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Disk read error' });
  });

  it('GET /history/:eventId returns 500 when getHistoryEntry throws', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetHistoryEntry.mockImplementation(() => {
      throw new Error('File system error');
    });
    const reply = fakeReply();
    routes.get('GET /history/:eventId')!(fakeReq({ params: { eventId: 'e1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'File system error' });
  });

  it('GET /history returns 500 when listHistory throws non-InvalidQueryError', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockImplementation(() => {
      throw new Error('Unexpected database error');
    });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: {} }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected database error' });
  });

  it('POST /push returns 400 when body is null', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: null }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, timeout?: number }; got: null',
    });
  });

  it('POST /push returns 400 when body is undefined', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({}), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, timeout?: number }; got: undefined',
    });
  });

  it('POST /push returns 400 when body is not an object', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: 'string' }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, timeout?: number }; got: "string"',
    });
  });

  it('POST /push returns 400 when event is missing', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { payload: { a: 1 } } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when event is empty string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: '', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when event is not a string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 123, payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when cwd is empty string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, cwd: '' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be a non-empty string',
    });
  });

  it('POST /push returns 400 when cwd is not a string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, cwd: 123 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be a non-empty string',
    });
  });

  it('POST /push returns 400 when timeout is 0', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: 0 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push returns 400 when timeout is negative', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: -5 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push returns 400 when timeout is not an integer', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: 5.5 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push forwards valid request to pushEvent and returns 200', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: { a: 1 } } }), asReply(reply));
    expect(mockPushEvent).toHaveBeenCalledWith(expect.any(String), 'onFoo', { a: 1 }, { cwd: undefined, timeout: undefined });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'queued', eventId: 'e1' });
  });

  it('POST /push returns 503 when DaemonUnreachableError is thrown', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockRejectedValue(new DaemonUnreachableError('Daemon is not running -- start it with `queue start`'));
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Daemon is not running -- start it with `queue start`',
    });
  });

  it('POST /push returns 500 for other errors', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockRejectedValue(new Error('Unexpected error'));
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected error' });
  });

  it('GET /subscribers returns 400 when cwd is duplicated', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: ['/path1', '/path2'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be given once, got 2 values',
    });
  });

  it('GET /subscribers returns 400 when event is duplicated', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { event: ['onFoo', 'onBar'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be given once, got 2 values',
    });
  });

  it('GET /subscribers uses default cwd when not provided', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockResolvedValue([]);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: {} }), asReply(reply));
    expect(mockListSubscribers).toHaveBeenCalledWith(expect.any(String), process.cwd(), undefined);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('GET /subscribers uses provided cwd', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockResolvedValue([]);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: '/custom/path' } }), asReply(reply));
    expect(mockListSubscribers).toHaveBeenCalledWith(expect.any(String), '/custom/path', undefined);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('POST /push forwards the request body to pushEvent', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: { a: 1 } } }), asReply(reply));
    expect(mockPushEvent).toHaveBeenCalledWith(expect.any(String), 'onFoo', { a: 1 }, { cwd: undefined, timeout: undefined });
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});
