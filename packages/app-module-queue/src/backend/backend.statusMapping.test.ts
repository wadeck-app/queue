import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

/**
 * The dashboard must not report success for what the daemon refused: the module used to answer HTTP 200 with whatever the daemon said, so the toast
 * said "Test event pushed" for a rejected push. These tests pin the HTTP status and the text the toast shows (`error` on a failure, `message` on a note).
 */

const { mockPushEvent, mockPushTestEvent, mockReplayEvent, mockReplayDlqEntry, mockClearDlqEntry, mockRetryEvent, mockRelayIsRunning, mockRelaySend } = vi.hoisted(() => ({
  mockPushEvent: vi.fn(),
  mockPushTestEvent: vi.fn(),
  mockReplayEvent: vi.fn(),
  mockReplayDlqEntry: vi.fn(),
  mockClearDlqEntry: vi.fn(),
  mockRetryEvent: vi.fn(),
  mockRelayIsRunning: vi.fn(),
  mockRelaySend: vi.fn(),
}));

vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));
vi.mock('./events.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./events.js')>()), pushTestEvent: mockPushTestEvent }));
vi.mock('./replay.js', () => ({ replayEvent: mockReplayEvent }));
vi.mock('./dlq.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./dlq.js')>()), replayDlqEntry: mockReplayDlqEntry, clearDlqEntry: mockClearDlqEntry }));
vi.mock('./retry.js', () => ({ retryEvent: mockRetryEvent }));
// The real getRelayInfo runs against a fake relay client
vi.mock('@wadeck-app/queue-relay-client/dist/relayClient.js', () => ({
  createRelayClient: vi.fn(() => ({ isRunning: mockRelayIsRunning, send: mockRelaySend })),
  relayStateDir: (dir: string) => `${dir}/relay-daemon`,
}));

import backend from './index.js';

function fakeReq(partial: Record<string, unknown> = {}): Parameters<ModuleRouteHandler>[0] {
  return partial as unknown as Parameters<ModuleRouteHandler>[0];
}

function fakeReply() {
  const send = vi.fn((body: unknown) => body);
  const code = vi.fn((_status: number) => ({ send }));
  return { code, send };
}

function routes(): Map<string, ModuleRouteHandler> {
  const map = new Map<string, ModuleRouteHandler>();
  const ctx = {
    dataDir: '/unused', setInterval: vi.fn(), setTimeout: vi.fn(), clearInterval: vi.fn(), clearTimeout: vi.fn(), on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    registerRoute: (method: string, subPath: string, handler: ModuleRouteHandler) => map.set(`${method} ${subPath}`, handler),
    fileVersion: vi.fn(),
    unchanged: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ModuleContext;
  backend(ctx);
  return map;
}

async function call(route: string, req: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const reply = fakeReply();
  await routes().get(route)!(fakeReq(req), reply as unknown as Parameters<ModuleRouteHandler>[1]);
  // The LAST code() call is the answer: a handler that calls code(200) before awaiting and code(500) in its catch has called it twice
  return { status: reply.code.mock.calls.at(-1)![0], body: reply.send.mock.calls.at(-1)![0] as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The three routes that push an event answer from the same PushResponse
const PUSH_ROUTES = [
  ['POST /push', { body: { event: 'onFoo', payload: {} } }, mockPushEvent],
  ['POST /events/:name/push-test', { params: { name: 'job.started' } }, mockPushTestEvent],
  ['POST /history/:eventId/replay', { params: { eventId: 'e1' } }, mockReplayEvent],
] as const;

describe.each(PUSH_ROUTES)('%s: a refused push is not a success', (route, req, mock) => {
  it('rejected: 422 with the reason, what the daemon accepts and a fix, in `error`', async () => {
    mock.mockResolvedValue({ status: 'rejected', reason: 'client protocol 9.0.0 is not accepted', supported: '1.x' });
    const { status, body } = await call(route, req);
    expect(status).toBe(422);
    expect(body['error']).toContain('client protocol 9.0.0 is not accepted');
    expect(body['error']).toContain('1.x');
    expect(body['error']).toContain('Fix:');
    expect(body['error']).toContain('nothing was recorded');
    expect(body).not.toHaveProperty('status');
  });

  it('rejected with a reason that already carries its fix: not repeated with a generic one', async () => {
    mock.mockResolvedValue({ status: 'rejected', reason: "the 'queue.' namespace is reserved. Fix: pick another event name" });
    const { status, body } = await call(route, req);
    expect(status).toBe(422);
    expect(String(body['error']).match(/Fix:/g)).toHaveLength(1);
  });

  it('aborted: 422 with the reason of the subscriber that aborted, and a fix', async () => {
    mock.mockResolvedValue({ status: 'aborted', reason: 'validate.sh exited with code 2' });
    const { status, body } = await call(route, req);
    expect(status).toBe(422);
    expect(body['error']).toContain('validate.sh exited with code 2');
    expect(body['error']).toContain('Fix:');
  });

  it('aborted without a reason still says so', async () => {
    mock.mockResolvedValue({ status: 'aborted' });
    const { status, body } = await call(route, req);
    expect(status).toBe(422);
    expect(body['error']).toContain('no reason given');
  });

  it('queued with no subscriber: 200 and a `message` that says nothing will run (the toast must not claim a delivery)', async () => {
    mock.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 0 });
    const { status, body } = await call(route, req);
    expect(status).toBe(200);
    expect(body['message']).toContain('queued, but no subscriber matches this event');
    expect(body).toMatchObject({ status: 'queued', eventId: 'e1', subscriberCount: 0 });
  });

  it('queued with subscribers: 200, the daemon answer unchanged; a push (not a replay) adds a message that only says the working directory it used', async () => {
    mock.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 2 });
    const { status, body } = await call(route, req);
    expect(status).toBe(200);
    if (route === 'POST /history/:eventId/replay') {
      expect(body).toEqual({ status: 'queued', eventId: 'e1', subscriberCount: 2 });
      return;
    }
    expect(body).toMatchObject({ status: 'queued', eventId: 'e1', subscriberCount: 2 });
    expect(String(body['message'])).toMatch(/^Pushed with the working directory of the dashboard process /);
    expect(String(body['message'])).not.toMatch(/no subscriber/);
  });
});

describe('POST /dlq/:id/replay', () => {
  it('not-found: 404 naming the id, in `error`', async () => {
    mockReplayDlqEntry.mockResolvedValue({ status: 'not-found' });
    const { status, body } = await call('POST /dlq/:id/replay', { params: { id: 'gone' } });
    expect(status).toBe(404);
    expect(body['error']).toContain('gone');
    expect(body['error']).toMatch(/reload|cleared|replayed/);
  });

  it('error: 409 with the daemon message in `error` (it says what to fix)', async () => {
    mockReplayDlqEntry.mockResolvedValue({ status: 'error', message: 'The replay of DLQ entry d1 did not start: Fix: repair subscribers.yml' });
    const { status, body } = await call('POST /dlq/:id/replay', { params: { id: 'd1' } });
    expect(status).toBe(409);
    expect(body['error']).toBe('The replay of DLQ entry d1 did not start: Fix: repair subscribers.yml');
  });

  it('error without a message: 409 with a fallback that points to the log', async () => {
    mockReplayDlqEntry.mockResolvedValue({ status: 'error' });
    const { status, body } = await call('POST /dlq/:id/replay', { params: { id: 'd1' } });
    expect(status).toBe(409);
    expect(body['error']).toContain('queue logs');
  });

  it('ok: 200 unchanged', async () => {
    mockReplayDlqEntry.mockResolvedValue({ status: 'ok' });
    const { status, body } = await call('POST /dlq/:id/replay', { params: { id: 'd1' } });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('POST /dlq/:id/clear', () => {
  it('cleared 0: 404 "no such DLQ entry" in `error`, not a success', async () => {
    mockClearDlqEntry.mockResolvedValue({ cleared: 0 });
    const { status, body } = await call('POST /dlq/:id/clear', { params: { id: 'gone' } });
    expect(status).toBe(404);
    expect(body['error']).toContain('no such DLQ entry');
    expect(body['error']).toContain('gone');
  });

  it('a request the daemon refused as malformed (reason): 400 with that reason', async () => {
    mockClearDlqEntry.mockResolvedValue({ cleared: 0, reason: "dlq-clear needs the id of one entry as { id: '<id>' }" });
    const { status, body } = await call('POST /dlq/:id/clear', { params: { id: 'x' } });
    expect(status).toBe(400);
    expect(body['error']).toContain('dlq-clear needs the id');
  });

  it('cleared 1: 200, the answer unchanged', async () => {
    mockClearDlqEntry.mockResolvedValue({ cleared: 1 });
    const { status, body } = await call('POST /dlq/:id/clear', { params: { id: 'd1' } });
    expect(status).toBe(200);
    expect(body).toEqual({ cleared: 1 });
  });
});

describe('POST /retry/:eventId', () => {
  it('a refusal keeps the daemon message in `error` (409)', async () => {
    mockRetryEvent.mockResolvedValue({ status: 'error', message: 'WAL entry w1 was already delivered (status acked)' });
    const { status, body } = await call('POST /retry/:eventId', { params: { eventId: 'w1' } });
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'WAL entry w1 was already delivered (status acked)' });
  });

  it('an error without a message still has an `error` (the toast shows only message/error), pointing to the log', async () => {
    mockRetryEvent.mockResolvedValue({ status: 'error' });
    const { status, body } = await call('POST /retry/:eventId', { params: { eventId: 'w1' } });
    expect(status).toBe(500);
    expect(typeof body['error']).toBe('string');
    expect(body['error']).toContain('queue logs');
  });

  it('ok: 200 unchanged', async () => {
    mockRetryEvent.mockResolvedValue({ status: 'ok' });
    const { status, body } = await call('POST /retry/:eventId', { params: { eventId: 'w1' } });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('GET /relay (the navbar badge)', () => {
  it('answers a running relay that does not answer its status with a JSON { error } that says what to do (never a bare 500)', async () => {
    mockRelayIsRunning.mockResolvedValue(true);
    mockRelaySend.mockRejectedValue(new Error('socket hang up'));
    const { status, body } = await call('GET /relay', {});
    expect(status).toBe(502);
    expect(typeof body['error']).toBe('string');
    expect(body['error']).toContain('socket hang up');
    expect(body['error']).toContain('did not answer its status');
    expect(body['error']).toContain('queue relay stop');
  });

  it('a relay that is not running is the normal "stopped" answer, 200', async () => {
    mockRelayIsRunning.mockResolvedValue(false);
    const { status, body } = await call('GET /relay', {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'stopped', label: 'Relay disconnected' });
  });
});
