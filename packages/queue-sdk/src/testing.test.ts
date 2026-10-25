import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackRequest } from './http.js';
import { createQueuePublisher } from './publisher.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { startFakeQueueDaemon, type FakeQueueDaemon } from './testing.js';

// The public test helper for the integrations that adopt the SDK: a throwaway daemon, so their tests run the real SDK path
// without touching the real daemon, its port or its registration with app-core.

const open: FakeQueueDaemon[] = [];

async function start(): Promise<FakeQueueDaemon> {
  const daemon = await startFakeQueueDaemon();
  open.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of open.splice(0)) {
    await daemon.close();
  }
});

describe('startFakeQueueDaemon', () => {
  it('gives a config dir the real SDK finds, and records what is pushed', async () => {
    const daemon = await start();
    const queue = createQueuePublisher({ configDir: daemon.configDir, cwd: join('some', 'project'), silent: true });

    const result = await queue.publishAndWait('app.thing', { n: 1 });

    expect(result.status).toBe('queued');
    expect(daemon.pushes()).toEqual([{ event: 'app.thing', payload: { n: 1 }, cwd: expect.stringContaining('project'), protocol: PROTOCOL_VERSION }]);
  });

  it('answers before* events as dispatched, like the real daemon', async () => {
    const daemon = await start();
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    await expect(queue.publishAndWait('beforeSave', {})).resolves.toMatchObject({ status: 'dispatched' });
  });

  it('can answer the next push with a chosen result (an aborted event, for the error path of the integration)', async () => {
    const daemon = await start();
    daemon.respondNext({ status: 'aborted', reason: 'refused by a subscriber' });
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });

    const refused = await queue.publishAndWait('beforeSave', {});
    expect(refused).toMatchObject({ status: 'dropped' });
    expect(refused.reason).toContain('refused by a subscriber');

    await expect(queue.publishAndWait('beforeSave', {})).resolves.toMatchObject({ status: 'dispatched' });
  });

  it('can break the connection on the next push (the unknown outcome path)', async () => {
    const daemon = await start();
    daemon.resetNext();
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    await expect(queue.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'unknown' });
  });

  it('records the declarations of registerEvents with their protocol, and answers registered like the daemon', async () => {
    const daemon = await start();
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    const events = [{ name: 'app.thing', description: 'A thing happened.', terminal: true }];

    await expect(queue.registerEvents('app', events)).resolves.toEqual({ status: 'registered', count: 1 });

    expect(daemon.registrations()).toEqual([{ source: 'app', events, protocol: PROTOCOL_VERSION }]);
    expect(daemon.pushes()).toEqual([]);
  });

  it('can answer the next registration with a chosen result (a rejected declaration, for the error path of the integration)', async () => {
    const daemon = await start();
    daemon.respondNextRegistration({ status: 'rejected', reason: 'invalid', problems: [{ path: 'events[0].name', message: 'bad' }] });
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });

    const refused = await queue.registerEvents('app', [{ name: 'x y', description: 'd' }]);
    expect(refused).toMatchObject({ status: 'rejected', problems: [{ path: 'events[0].name', message: 'bad' }] });

    await expect(queue.registerEvents('app', [])).resolves.toEqual({ status: 'registered', count: 0 });
  });

  it('behaves like a 1.0.x daemon with protocolVersion: nothing is registered, the SDK answers unsupported, pushes still work', async () => {
    const daemon = await startFakeQueueDaemon({ protocolVersion: '1.0.0' });
    open.push(daemon);
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });

    const result = await queue.registerEvents('app', [{ name: 'app.thing', description: 'd' }]);

    expect(result.status).toBe('unsupported');
    expect(daemon.registrations()).toEqual([]);
    await expect(queue.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'queued' });
  });

  it('a 1.0.x fake also answers HTTP 404 Unknown command to a client that sends the command anyway', async () => {
    const daemon = await startFakeQueueDaemon({ protocolVersion: '1.0.0' });
    open.push(daemon);
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    await queue.status();
    const token = readFileSync(join(daemon.configDir, 'health_token'), 'utf8').trim();
    const port = JSON.parse(readFileSync(join(daemon.configDir, 'config.port'), 'utf8')).port as number;

    const outcome = await loopbackRequest({ port, method: 'POST', path: '/register-events', headers: { Authorization: `Bearer ${token}` }, body: '{}', timeoutMs: 300_000 });

    expect(outcome).toMatchObject({ kind: 'response', status: 404 });
    expect(daemon.registrations()).toEqual([]);
  });

  it('removes its temporary config dir when closed', async () => {
    const daemon = await startFakeQueueDaemon();
    expect(existsSync(daemon.configDir)).toBe(true);
    await daemon.close();
    expect(existsSync(daemon.configDir)).toBe(false);
  });
});

describe('startFakeQueueDaemon: breaking the connection on a registration', () => {
  it('one broken registration is retried by the SDK (it is idempotent) and succeeds', async () => {
    const daemon = await start();
    daemon.resetNextRegistration();
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    await expect(queue.registerEvents('demo', [{ name: 'demo.a', description: 'd' }])).resolves.toMatchObject({ status: 'registered' });
  });

  it('two broken registrations in a row leave the outcome unknown', async () => {
    const daemon = await start();
    daemon.resetNextRegistration(2);
    const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
    await expect(queue.registerEvents('demo', [{ name: 'demo.a', description: 'd' }])).resolves.toMatchObject({ status: 'unknown' });
  });
});

describe('the fake daemon records the project of a push', () => {
  it('RecordedPush carries the project id when the SDK sent one', async () => {
    const daemon = await startFakeQueueDaemon();
    try {
      const publisher = createQueuePublisher({ configDir: daemon.configDir, silent: true, project: '569c412d' });
      await publisher.publishAndWait('app.thing', { n: 1 });
      expect(daemon.pushes()[0]).toMatchObject({ event: 'app.thing', project: '569c412d' });
    } finally {
      await daemon.close();
    }
  });
});
