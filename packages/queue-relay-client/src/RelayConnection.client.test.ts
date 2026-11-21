import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { RelayConnection } from './RelayConnection.js';
import { waitFor } from './testing/waitFor.js';

const { mockPushModule } = vi.hoisted(() => ({
  mockPushModule: { ensureDaemonRunning: vi.fn().mockResolvedValue(undefined), pushToQueue: vi.fn().mockResolvedValue({ status: 'ok' }) },
}));
vi.mock('./push.js', () => mockPushModule);

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmpDir = undefined;
  }
});

/** A relay that records the User-Agent of the handshake and the first message (the auth) of one connection. */
async function runAgainstFakeRelay(clientVersion: string | undefined): Promise<{ userAgent: string | undefined; auth: Record<string, unknown> }> {
  tmpDir = join(tmpdir(), `queue-relay-client-id-${crypto.randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const wss = new WebSocketServer({ port: 0 });
  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test relay is not listening on a TCP port');
  }
  const pluginPath = join(tmpDir, 'plugin.js');
  writeFileSync(pluginPath, "export default { source: 'test', mapEvent: (e) => ({ event: `test.${e.eventType}`, payload: e.payload }) };");
  writeFileSync(join(tmpDir, 'relay.yml'), `relayUrl: ws://127.0.0.1:${address.port}\ntoken: a-token\nplugins:\n  - module: ${pluginPath}\n    subscriptions:\n      - eventType: [test]\n`);
  let userAgent: string | undefined;
  let auth: Record<string, unknown> | undefined;
  wss.on('connection', (ws, request) => {
    userAgent = request.headers['user-agent'];
    ws.on('message', (data) => {
      auth ??= JSON.parse(String(data)) as Record<string, unknown>;
      ws.send(JSON.stringify({ type: 'authenticated', username: 'test' }));
    });
  });
  const connection = new RelayConnection({ configDir: tmpDir, retryDelayMs: 10, ...(clientVersion !== undefined && { clientVersion }) });
  try {
    const started = connection.start();
    await waitFor(() => auth !== undefined, 'the relay to receive the auth message');
    connection.stop();
    await started;
    return { userAgent, auth: auth! };
  } finally {
    wss.close();
  }
}

describe('RelayConnection: who it says it is', () => {
  it('sends client "queue-cli/<version> host=..." in the auth message and queue-cli/<version> as User-Agent, and still the token', async () => {
    const { userAgent, auth } = await runAgainstFakeRelay('2026.11.21-314-e480bf1c');
    expect(auth['type']).toBe('auth');
    expect(auth['token']).toBe('a-token');
    expect(String(auth['client'])).toMatch(/^queue-cli\/2026\.11\.21-314-e480bf1c host=\S+/);
    expect(String(auth['client']).length).toBeLessThanOrEqual(64);
    expect(userAgent).toBe('queue-cli/2026.11.21-314-e480bf1c');
  });

  it('without a client version nothing is added: the auth message holds the type and the token only', async () => {
    const { auth } = await runAgainstFakeRelay(undefined);
    expect(Object.keys(auth).sort()).toEqual(['token', 'type']);
  });
});
