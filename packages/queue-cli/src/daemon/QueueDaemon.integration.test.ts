import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getQueueProtocolInfo } from '@wadeck-app/queue-core';
import { startDaemon } from './QueueDaemon.js';

// The real daemon (kit + queue service) on a free port in a throwaway config dir: what an SDK or any HTTP client meets.

interface Answer {
  status: number;
  body: unknown;
}

function call(port: number, method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? '' : JSON.stringify(options.body);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data === '' ? null : JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`${path} did not appear within ${timeoutMs} ms`);
}

const RELEASE = '2026.10.24-test-1';

describe('queue daemon over HTTP', () => {
  let configDir: string;
  let projectDir: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-daemon-it-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'queue-daemon-it-project-'));
    await startDaemon(configDir, { port: 0, version: RELEASE });
    port = (JSON.parse(await waitForFile(join(configDir, 'config.port'), 5000)) as { port: number }).port;
    token = (await waitForFile(join(configDir, 'health_token'), 5000)).trim();
  });

  afterAll(async () => {
    await call(port, 'POST', '/quit', { token });
    // the daemon removes its port file on a clean stop: wait for it before deleting the directory
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(configDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('advertises its push protocol in GET /version, without a token', async () => {
    const answer = await call(port, 'GET', '/version');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ pid: process.pid, queueProtocol: getQueueProtocolInfo() });
  });

  it('reports the queue release it was started from, not the daemon library default', async () => {
    const answer = await call(port, 'GET', '/version');
    expect(answer.body).toMatchObject({ version: RELEASE });
  });

  it('refuses a push without the token', async () => {
    const answer = await call(port, 'POST', '/push', { body: { event: 'it.noauth', payload: {}, cwd: projectDir } });
    expect(answer.status).toBe(401);
  });

  it('queues a push that does not say its protocol (every client that exists today)', async () => {
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.legacy', payload: {}, cwd: projectDir } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'queued', subscriberCount: 0 } });
  });

  it('queues a push that speaks the current protocol', async () => {
    const { version } = getQueueProtocolInfo();
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.current', payload: {}, cwd: projectDir, protocol: version } });
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'queued' } });
  });

  it('answers a push of an unaccepted protocol MAJOR with rejected and the accepted range', async () => {
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.future', payload: {}, cwd: projectDir, protocol: '9.0.0' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'rejected', supported: getQueueProtocolInfo().accepts } });
  });
});
