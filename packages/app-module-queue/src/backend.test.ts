import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError } from './errors.js';

const {
  mockGetStatus,
  mockListHistory,
  mockGetHistoryEntry,
  mockReplayEvent,
  mockListDlq,
  mockReplayDlqEntry,
  mockClearDlqEntry,
  mockListSubscribers,
  mockPushEvent,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockListHistory: vi.fn(),
  mockGetHistoryEntry: vi.fn(),
  mockReplayEvent: vi.fn(),
  mockListDlq: vi.fn(),
  mockReplayDlqEntry: vi.fn(),
  mockClearDlqEntry: vi.fn(),
  mockListSubscribers: vi.fn(),
  mockPushEvent: vi.fn(),
}));

vi.mock('./status.js', () => ({ getStatus: mockGetStatus }));
vi.mock('./history.js', () => ({ listHistory: mockListHistory, getHistoryEntry: mockGetHistoryEntry }));
vi.mock('./replay.js', () => ({ replayEvent: mockReplayEvent }));
vi.mock('./dlq.js', () => ({ listDlq: mockListDlq, replayDlqEntry: mockReplayDlqEntry, clearDlqEntry: mockClearDlqEntry }));
vi.mock('./subscribers.js', () => ({ listSubscribers: mockListSubscribers }));
vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));

import backend from './backend.js';

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
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    on: vi.fn(),
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
      'GET /history',
      'GET /history/:eventId',
      'POST /history/:eventId/replay',
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
    mockGetStatus.mockResolvedValue({ daemonRunning: true, pendingCount: 1, dlqCount: 0 });
    const reply = fakeReply();
    await routes.get('GET /status')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ daemonRunning: true, pendingCount: 1, dlqCount: 0 });
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

  it('GET /dlq returns 503 when the daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDlq.mockRejectedValue(new Error('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('GET /status returns 500 when getStatus throws', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetStatus.mockRejectedValue(new Error('Disk read error'));
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
