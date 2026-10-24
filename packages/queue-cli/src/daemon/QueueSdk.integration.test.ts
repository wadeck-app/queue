import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueuePublisher, PROTOCOL_VERSION, type QueueFailure } from '@wadeck-app/queue-sdk';
import { getEventDetail, listEvents } from '@wadeck-app/queue-core';
import { startDaemon } from './QueueDaemon.js';
import { waitFor } from '../testWaitFor.js';

// The public SDK against the real daemon (kit + queue service) on a free port in a throwaway config dir: what an integration meets.
// `queue start` is never run here: PATH is emptied in the stopped-daemon test, so no real daemon can be started by accident.

function historyText(configDir: string): string {
  const dir = join(configDir, 'history');
  if (!existsSync(dir)) {
    return '';
  }
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

function quit(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/quit', headers: { Authorization: `Bearer ${token}`, 'Content-Length': 0 } }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end();
  });
}

describe('@wadeck-app/queue-sdk against the real queue daemon', () => {
  let configDir: string;
  let projectDir: string;
  let port: number;
  let token: string;
  let daemonStopped = false;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-sdk-it-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'queue-sdk-it-project-'));
    await startDaemon(configDir, { port: 0 });
    const portFile = join(configDir, 'config.port');
    port = (JSON.parse(await waitFor(() => (existsSync(portFile) ? readFileSync(portFile, 'utf8') : undefined), 'the port file')) as { port: number }).port;
    token = (await waitFor(() => (existsSync(join(configDir, 'health_token')) ? readFileSync(join(configDir, 'health_token'), 'utf8') : undefined), 'the token')).trim();
  });

  afterAll(async () => {
    if (!daemonStopped) {
      await quit(port, token);
      await waitFor(() => !existsSync(join(configDir, 'config.port')), 'the daemon to remove its port file after /quit');
    }
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('publishes an event the daemon records in its history, with the project directory and the negotiated protocol', async () => {
    const failures: QueueFailure[] = [];
    const queue = createQueuePublisher({ configDir, cwd: projectDir, silent: true, onError: (failure) => failures.push(failure) });

    const result = await queue.publishAndWait('sdk.it.hello', { n: 1 });

    expect(failures).toEqual([]);
    expect(result).toMatchObject({ status: 'queued' });
    expect(result.eventId).toEqual(expect.any(String));
    expect(historyText(configDir)).toContain('"event":"sdk.it.hello"');
    await expect(queue.status()).resolves.toMatchObject({ available: true, via: 'daemon', protocol: PROTOCOL_VERSION });
  });

  it('declares the events of a program: the real daemon stores them and the catalog read model lists them next to what was pushed', async () => {
    const failures: QueueFailure[] = [];
    const queue = createQueuePublisher({ configDir, cwd: projectDir, silent: true, onError: (failure) => failures.push(failure) });

    const declared = await queue.registerEvents('sdk-it', [
      {
        name: 'sdk.it.done',
        description: 'The integration test finished. Fires once per run.',
        schema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        example: { runId: 'r1' },
        correlationKey: 'payload.runId',
        terminal: true,
        outcome: 'success',
      },
      { name: 'sdk.it.hello', description: 'The first test pushes it.' },
    ]);
    expect(failures).toEqual([]);
    expect(declared).toEqual({ status: 'registered', count: 2 });

    const listing = listEvents(configDir);
    expect(listing.sources).toMatchObject([{ source: 'sdk-it', eventCount: 2 }]);
    // sdk.it.hello was pushed by the first test of this file: declared AND seen
    expect(listing.events.find((event) => event.name === 'sdk.it.hello')).toMatchObject({ declared: true, source: 'sdk-it', count24h: 1 });
    expect(listing.events.find((event) => event.name === 'sdk.it.done')).toMatchObject({ declared: true, terminal: true, outcome: 'success', correlationKey: ['payload.runId'], count24h: 0 });
    expect(getEventDetail(configDir, 'sdk.it.done')?.waitExample).toBe('queue wait sdk.it.done --when "payload.runId=<runId>" --since 5m --json');
  });

  it('refuses an invalid declaration with every problem and its path, and stores nothing of it', async () => {
    const queue = createQueuePublisher({ configDir, cwd: projectDir, silent: true });
    const result = await queue.registerEvents('sdk-it-bad', [{ name: 'bad name', description: '' }]);
    expect(result.status).toBe('rejected');
    expect(result.problems?.map((problem) => problem.path)).toEqual(['events[0].name', 'events[0].description']);
    expect(listEvents(configDir).sources.map((source) => source.source)).not.toContain('sdk-it-bad');
  });

  it('fire-and-forget publish plus flush records the event too', async () => {
    const queue = createQueuePublisher({ configDir, cwd: projectDir, silent: true });
    queue.publish('sdk.it.forget', {});
    await queue.flush();
    expect(historyText(configDir)).toContain('"event":"sdk.it.forget"');
  });

  it('reports, without throwing, that the daemon is not running and queue is not installed once the daemon stopped', async () => {
    await quit(port, token);
    daemonStopped = true;
    await waitFor(() => (existsSync(join(configDir, 'config.port')) ? undefined : true), 'the daemon removing its port file');

    const savedPath = process.env['PATH'];
    const savedPathExt = process.env['PATHEXT'];
    const emptyBin = mkdtempSync(join(tmpdir(), 'queue-sdk-it-emptybin-'));
    process.env['PATH'] = emptyBin;
    try {
      const failures: QueueFailure[] = [];
      const queue = createQueuePublisher({ configDir, cwd: projectDir, silent: true, onError: (failure) => failures.push(failure) });
      const result = await queue.publishAndWait('sdk.it.lost', {});

      expect(result.status).toBe('dropped');
      expect(result.reason).toMatch(/queue is not installed or not on PATH/);
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures)).not.toContain(token);
    } finally {
      process.env['PATH'] = savedPath;
      if (savedPathExt !== undefined) {
        process.env['PATHEXT'] = savedPathExt;
      }
      rmSync(emptyBin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
