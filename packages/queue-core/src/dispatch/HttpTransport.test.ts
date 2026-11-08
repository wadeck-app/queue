import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from './HttpTransport.js';
import type { EventEnvelope } from '../types.js';

let server: Server;
let url: string;

beforeAll(async () => {
  // Accepts the request and never answers: only the timeout ends it
  server = createServer(() => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

const envelope: EventEnvelope = { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTest', payload: {}, meta: { cwd: '/tmp' } };

describe('HttpTransport timeout message', () => {
  it('prints a timeout under one second in milliseconds, not as 0s', async () => {
    const result = await new HttpTransport().dispatch(url, 'POST', undefined, envelope, 200);
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout after 200ms');
  });
});
