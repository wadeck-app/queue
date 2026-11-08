import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { DaemonHandle } from '@wadeck-app/singleton-daemon-kit';
import { pushToQueue } from './push.js';

// pushToQueue is NOT mocked here: it goes through the real daemon client and the real HTTP protocol to a real daemon (singleton-daemon-kit)
// whose `push` command is a recorder. Only the queue's own dispatch behind that command is replaced.
describe('pushToQueue (real client, recording daemon)', () => {
  let configDir = '';
  let daemon: DaemonHandle | null = null;

  afterEach(async () => {
    await daemon?.stop('command');
    daemon = null;
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('sends the event, the payload and cwd = the config dir, and returns the daemon answer', async () => {
    configDir = join(tmpdir(), `queue-relay-pushreal-test-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    const received: unknown[] = [];
    daemon = await createDaemon({
      configDir,
      port: 0,
      idleTimeout: null,
      commands: {
        push: (payload?: unknown) => {
          received.push(payload);
          return { status: 'queued', eventId: 'e1' };
        },
      },
    });

    const result = await pushToQueue(configDir, 'on.github.push', { ref: 'refs/heads/main' });

    expect(received).toEqual([{ event: 'on.github.push', payload: { ref: 'refs/heads/main' }, cwd: configDir }]);
    expect(result).toEqual({ status: 'queued', eventId: 'e1' });
  });

  it('rejects with an error when no daemon runs for that config dir', async () => {
    configDir = join(tmpdir(), `queue-relay-pushreal-test-${crypto.randomUUID()}`);
    mkdirSync(configDir, { recursive: true });
    await expect(pushToQueue(configDir, 'on.github.push', {})).rejects.toThrow();
  });
});
