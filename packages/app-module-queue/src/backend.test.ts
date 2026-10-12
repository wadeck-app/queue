import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

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

  it('POST /history/:eventId/replay returns 409 with the error message on ReplayError', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new Error('No history entry found for eventId x'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({ error: 'No history entry found for eventId x' });
  });

  it('GET /dlq returns 503 when the daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDlq.mockRejectedValue(new Error('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
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
