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

describe('RelayConnection: two plugin entries for one source', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('refuses the configuration with a message naming both modules, and never connects', async () => {
    tmpDir = join(tmpdir(), `queue-relay-dupsource-test-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    const logs: string[] = [];
    let connectionCount = 0;

    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', () => {
      connectionCount++;
    });
    const address = wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The test server is not listening on a TCP port');
    }

    const first = join(tmpDir, 'first.js');
    const second = join(tmpDir, 'second.js');
    writeFileSync(first, "export default { source: 'github', mapEvent: () => null };");
    writeFileSync(second, "export default { source: 'github', mapEvent: () => null };");
    writeFileSync(
      join(tmpDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${address.port}\ntoken: t\nplugins:\n  - module: ${first}\n    subscriptions:\n      - eventType: [push]\n  - module: ${second}\n    subscriptions:\n      - eventType: [issues]\n`
    );

    // Each pass of the loop that would connect goes through this sleep: passes without a connection prove the refusal
    let passes = 0;
    const connection = new RelayConnection({
      configDir: tmpDir,
      retryDelayMs: 1,
      sleep: () => {
        passes++;
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
      onLog: (line) => logs.push(line),
    });

    try {
      const startPromise = connection.start();
      await waitFor(() => passes >= 5, 'five passes of the connection loop');
      connection.stop();
      await startPromise;

      expect(connectionCount).toBe(0);
      const diag = connection.getDiagnostics();
      expect(diag.lastError).toContain('Failed to load plugins');
      expect(diag.lastError).toContain('both handle the source "github"');
      expect(diag.lastError).toContain(first);
      expect(diag.lastError).toContain(second);
      expect(diag.lastError).toContain('one plugin entry per source');
    } finally {
      wss.close();
    }
  });
});
