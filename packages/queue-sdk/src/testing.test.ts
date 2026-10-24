import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueuePublisher } from './publisher.js';
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
    expect(daemon.pushes()).toEqual([{ event: 'app.thing', payload: { n: 1 }, cwd: expect.stringContaining('project'), protocol: '1.0.0' }]);
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

  it('removes its temporary config dir when closed', async () => {
    const daemon = await startFakeQueueDaemon();
    expect(existsSync(daemon.configDir)).toBe(true);
    await daemon.close();
    expect(existsSync(daemon.configDir)).toBe(false);
  });
});
