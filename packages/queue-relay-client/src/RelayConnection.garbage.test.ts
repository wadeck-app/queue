import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { RelayConnection } from './RelayConnection.js';
import { waitFor } from './testing/waitFor.js';

vi.mock('./push.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
  pushToQueue: vi.fn().mockResolvedValue({ status: 'ok' }),
}));

// A retry delay no test ever reaches
const NEVER_MS = 3_600_000;

describe('RelayConnection: frames that are not JSON (a proxy answering instead of the relay)', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('drops the frame, logs each distinct cause once (first 200 chars) and keeps the connection', async () => {
    tmpDir = join(tmpdir(), `queue-relay-garbage-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    const logs: string[] = [];
    let connectionCount = 0;

    const wss = new WebSocketServer({ port: 0 });
    const address = wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The test server is not listening on a TCP port');
    }

    const pluginPath = join(tmpDir, 'plugin.js');
    writeFileSync(pluginPath, "export default { source: 'test', mapEvent: (e) => ({ event: `test.${e.eventType}`, payload: e.payload }) };");
    writeFileSync(
      join(tmpDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${address.port}\ntoken: test-token\nplugins:\n  - module: ${pluginPath}\n    subscriptions:\n      - eventType: [test]\n`
    );

    const html = `<html>502 Bad Gateway ${'x'.repeat(400)}</html>`;
    const other = 'not json at all';
    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', () => {
        // The same cause twice, another cause, then a real message: the real one must still be handled
        ws.send(html);
        ws.send(html);
        ws.send(other);
        ws.send(JSON.stringify({ type: 'authenticated', username: 'tester' }));
      });
    });

    const connection = new RelayConnection({
      configDir: tmpDir,
      retryDelayMs: NEVER_MS,
      reconnect: { minMs: NEVER_MS, maxMs: NEVER_MS, authBlockedMs: NEVER_MS, tryAgainMs: NEVER_MS, abuseMs: NEVER_MS, random: () => 0.5 },
      onLog: (line) => logs.push(line),
    });

    try {
      const startPromise = connection.start();
      await waitFor(() => connection.isConnected(), 'the authenticated message that follows the garbage frames');

      const garbageLogs = logs.filter((line) => line.includes('not JSON'));
      expect(garbageLogs).toHaveLength(2);
      expect(garbageLogs[0]).toContain(html.slice(0, 200));
      expect(garbageLogs[0]).not.toContain(html.slice(0, 201));
      expect(garbageLogs[1]).toContain(other);
      expect(connectionCount).toBe(1);

      connection.stop();
      await startPromise;
    } finally {
      wss.close();
    }
  });
});
