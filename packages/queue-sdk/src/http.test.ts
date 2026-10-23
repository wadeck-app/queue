import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackRequest } from './http.js';

const servers: Server[] = [];

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
    expect(await loopbackRequest({ port, method: 'GET', path: '/x', timeoutMs: 1000 })).toEqual({ kind: 'response', status: 201, text: 'hello' });
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
    await loopbackRequest({ port, method: 'POST', path: '/push', headers: { 'x-test': 'v' }, body: '{"a":1}', timeoutMs: 1000 });
    expect(seen).toBe('POST /push v {"a":1}');
  });

  it('reports a refused connection as not connected', async () => {
    const port = await closedPort();
    const outcome = await loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'failure', code: 'ECONNREFUSED', connected: false, timedOut: false });
  });

  it('reports a reset after connection as connected', async () => {
    const port = await listen((req) => {
      req.socket.destroy();
    });
    const outcome = await loopbackRequest({ port, method: 'POST', path: '/', body: '{}', timeoutMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'failure', connected: true, timedOut: false });
  });

  it('reports a timeout as connected and timedOut', async () => {
    const port = await listen(() => undefined);
    const outcome = await loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: 50 });
    expect(outcome).toMatchObject({ kind: 'failure', connected: true, timedOut: true });
  });

  it('fails on a response larger than the cap', async () => {
    const port = await listen((_req, res) => {
      res.end('x'.repeat(2000));
    });
    const outcome = await loopbackRequest({ port, method: 'GET', path: '/', timeoutMs: 1000, maxBytes: 100 });
    expect(outcome).toMatchObject({ kind: 'failure', connected: true });
    expect(outcome.kind === 'failure' && outcome.message).toContain('100');
  });
});
