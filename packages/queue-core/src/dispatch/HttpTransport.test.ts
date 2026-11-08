import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport, MAX_HTTP_RESPONSE_BYTES } from './HttpTransport.js';
import type { EventEnvelope } from '../types.js';

interface Seen {
  method: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
  path: string | undefined;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
// What the server does for the next request; set by each test
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf-8'), path: req.url });
      handler(req, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  seen = [];
  handler = () => undefined;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

const envelope: EventEnvelope = { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTest', payload: { a: 1 }, meta: { cwd: '/tmp' } };

describe('HttpTransport timeout message', () => {
  it('prints a timeout under one second in milliseconds, not as 0s', async () => {
    // Accepts the request and never answers: only the timeout ends it
    handler = () => undefined;
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 200);
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout after 200ms');
  });
});

describe('HttpTransport timer', () => {
  it('arms the timeout of the subscriber and releases the timer once the exchange is over, whatever its outcome', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const released = vi.spyOn(globalThis, 'clearTimeout');
    handler = (_req, res) => { res.writeHead(200); res.end('ok'); };
    // An unusual value, so that no timer of the runtime can be taken for ours
    await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 4321);
    const index = armed.mock.calls.findIndex((call) => call[1] === 4321);
    expect(index, 'no timer was armed with the timeout of the subscriber').toBeGreaterThanOrEqual(0);
    expect(released).toHaveBeenCalledWith(armed.mock.results[index]!.value);
  });
});

describe('HttpTransport request', () => {
  it('sends the method, the custom headers (which win over the default content type) and the envelope as the body', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('ok'); };
    await new HttpTransport().dispatch(`${base}/hook`, 'PUT', { 'X-Token': 'abc', 'Content-Type': 'application/vnd.test+json' }, envelope, 5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.path).toBe('/hook');
    expect(seen[0]!.headers['x-token']).toBe('abc');
    expect(seen[0]!.headers['content-type']).toBe('application/vnd.test+json');
    expect(JSON.parse(seen[0]!.body)).toEqual(envelope);
  });

  it('defaults the content type to application/json', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end(); };
    await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });
});

describe('HttpTransport status', () => {
  it.each([200, 201, 204, 299])('%i is a success and returns the body', async (status) => {
    handler = (_req, res) => { res.writeHead(status); res.end(status === 204 ? undefined : 'body'); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe(status === 204 ? '' : 'body');
    expect(result.error).toBeUndefined();
  });

  it.each([400, 404, 500, 503])('%i is a failure that names the status and keeps the body', async (status) => {
    handler = (_req, res) => { res.writeHead(status); res.end('why'); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`HTTP ${status}`);
    expect(result.stdout).toBe('why');
  });
});

describe('HttpTransport response body', () => {
  it('times out when the server sends the headers and then stalls the body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial'); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 300);
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout after 300ms');
  });

  it('refuses a body above the limit and says which limit', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('x'.repeat(MAX_HTTP_RESPONSE_BYTES + 10)); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 10_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('1 MiB');
    expect(result.error).toContain('HTTP 200');
    expect((result.stdout ?? '').length).toBeLessThanOrEqual(MAX_HTTP_RESPONSE_BYTES);
  });

  it('the limit is the 1 MiB the error message and the docs announce', () => {
    expect(MAX_HTTP_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it('refuses a body one byte above the limit', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('x'.repeat(MAX_HTTP_RESPONSE_BYTES + 1)); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 10_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('1 MiB');
    expect(result.stdout).toHaveLength(MAX_HTTP_RESPONSE_BYTES);
  });

  it('accepts a body of exactly the limit', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('x'.repeat(MAX_HTTP_RESPONSE_BYTES)); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 10_000);
    expect(result.success).toBe(true);
    expect(result.stdout).toHaveLength(MAX_HTTP_RESPONSE_BYTES);
  });
});

describe('HttpTransport redirects: custom headers and the envelope must never be forwarded to another origin', () => {
  let other: Server;
  let otherSeen = 0;
  let otherBase: string;

  beforeAll(async () => {
    other = createServer((_req, res) => { otherSeen++; res.writeHead(200); res.end('reached'); });
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    other.closeAllConnections();
    await new Promise<void>((done) => other.close(() => done()));
  });

  // 300 and 399 are the edges of the 3xx range, 299 and 400 (tested above) the first statuses outside it
  it.each([300, 301, 302, 303, 307, 308, 399])('%i is a failure naming the origin of the Location, and the target is never called', async (status) => {
    otherSeen = 0;
    handler = (_req, res) => { res.writeHead(status, { Location: `${otherBase}/steal?token=SECRETQUERY` }); res.end(); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', { Authorization: 'Bearer SECRETHEADER' }, envelope, 5_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(result.error).toContain(otherBase);
    expect(result.error).toContain('not followed');
    expect(result.error).not.toContain('SECRETHEADER');
    expect(result.error).not.toContain('SECRETQUERY');
    expect(otherSeen).toBe(0);
  });

  it('resolves a relative Location against the url and strips user info from the origin it names', async () => {
    handler = (_req, res) => { res.writeHead(302, { Location: '/elsewhere' }); res.end(); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(result.error).toContain(base);
    handler = (_req, res) => { res.writeHead(302, { Location: 'https://user:pw@example.test/x' }); res.end(); };
    const second = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(second.error).toContain('https://example.test');
    expect(second.error).not.toContain('pw');
  });

  it('a redirect status without a usable Location is still a failure', async () => {
    handler = (_req, res) => { res.writeHead(304); res.end(); };
    const result = await new HttpTransport().dispatch(`${base}/`, 'POST', undefined, envelope, 5_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 304');
  });
});
