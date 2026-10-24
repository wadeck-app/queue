import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackRequest } from './http.js';

const servers: Server[] = [];

// Request deadline of the cases where the server DOES answer: a guard against a hang, never a performance limit.
const GUARD_MS = 300_000;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const port = await listen(() => undefined);
  const server = servers.pop() as Server;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('loopbackRequest', () => {
  it('returns status and text of a response', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 201;
      res.end('hello');
    });
    expect(await loopbackRequest({ port, method: 'GET', path: '/x', timeoutMs: GUARD_MS })).toEqual({ kind: 'response', status: 201, text: 'hello' });
  });

  it('sends method, path, headers and body', async () => {
    let seen = '';
    const port = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen = `${req.method} ${req.url} ${req.headers['x-test']} ${body}`;
        res.end('ok');
      });
    });
    await loopbackRequest({ port, method: 'POST', path: '/push', headers: { 'x-test': 'v' }, body: '{"a":1}', timeoutMs: GUARD_MS });
    expect(seen).toBe('POST /push v {"a":1}');
  });

  it('reports a refused connection as not connected', async () => {
    const port = await closedPort();
    const outcome = await loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: GUARD_MS });
    expect(outcome).toMatchObject({ kind: 'failure', code: 'ECONNREFUSED', connected: false, timedOut: false });
  });

  it('reports a reset after connection as connected', async () => {
    const port = await listen((req) => {
      req.socket.destroy();
    });
    const outcome = await loopbackRequest({ port, method: 'POST', path: '/', body: '{}', timeoutMs: GUARD_MS });
    expect(outcome).toMatchObject({ kind: 'failure', connected: true, timedOut: false });
  });

  it('reports a timeout as connected and timedOut', async () => {
    // The server never answers. The request deadline is a faked timer that the test fires only once the server HAS received the
    // request, so a slow machine can neither trip it before the connection exists nor delay it.
    let requestReceived: () => void = () => undefined;
    const received = new Promise<void>((resolve) => { requestReceived = resolve; });
    const port = await listen(() => { requestReceived(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: 50 });
    await received;
    vi.advanceTimersByTime(50);
    expect(await pending).toMatchObject({ kind: 'failure', connected: true, timedOut: true });
  });

  it('fails on a response larger than the cap', async () => {
    const port = await listen((_req, res) => {
      res.end('x'.repeat(2000));
    });
    const outcome = await loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: GUARD_MS, maxBytes: 100 });
    expect(outcome).toMatchObject({ kind: 'failure', connected: true });
    expect(outcome.kind === 'failure' && outcome.message).toContain('100');
  });
});
