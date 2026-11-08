import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { RelayConnection, type RelayConnectionOptions } from './RelayConnection.js';

vi.mock('./push.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
  pushToQueue: vi.fn().mockResolvedValue({ status: 'ok' }),
}));

// The reconnect loop is driven with an injected sleep (it records the delay it is asked for and returns at once) and an injected
// random: the delays are read, never measured.

// Distinct sentinel values, so a delay can only come from the setting it is supposed to come from
const SPECIAL = { authBlockedMs: 333_000, tryAgainMs: 222_000, abuseMs: 111_000 };

type FakeRelay =
  | { kind: 'ws-close'; code: number }
  | { kind: 'ws-drop' }
  /** The nth connection ends as the nth step says (a close code, or a dropped socket); the last step repeats. */
  | { kind: 'ws-script'; steps: Array<number | 'drop'> }
  | { kind: 'http'; status: number };

interface Started {
  port: number;
  close: () => Promise<void>;
}

async function startFakeRelay(behaviour: FakeRelay): Promise<Started> {
  if (behaviour.kind === 'http') {
    const server: Server = createServer();
    server.on('upgrade', (_req, socket: Duplex) => {
      socket.write(`HTTP/1.1 ${behaviour.status} Whatever\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The test server is not listening on a TCP port');
    }
    return { port: address.port, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
  }
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  wss.on('connection', (ws) => {
    const step = behaviour.kind === 'ws-script' ? behaviour.steps[Math.min(connections, behaviour.steps.length - 1)] : undefined;
    connections += 1;
    ws.on('message', () => {
      // The first message is the auth: answer with the scripted end of the connection
      if (behaviour.kind === 'ws-close') {
        ws.close(behaviour.code);
      } else if (typeof step === 'number') {
        ws.close(step);
      } else {
        ws.terminate();
      }
    });
  });
  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not listening on a TCP port');
  }
  return { port: address.port, close: () => new Promise<void>((resolve) => { wss.close(() => resolve()); }) };
}

describe('RelayConnection reconnect backoff (delays read from an injected sleep)', () => {
  // Every directory a test made: one test runs several scenarios, so a single variable would only remember (and remove) the last one
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  /** Runs the loop against a scripted relay until it asked for `count` waits, and returns them in order. */
  async function delaysAsked(behaviour: FakeRelay, count: number, reconnect: RelayConnectionOptions['reconnect']): Promise<number[]> {
    return (await scenario(behaviour, count, reconnect)).asked;
  }

  /** Same, and also what the connection reports as its last error once the waits were asked. */
  async function scenario(behaviour: FakeRelay, count: number, reconnect: RelayConnectionOptions['reconnect']): Promise<{ asked: number[]; lastError: string | null }> {
    const tmpDir = join(tmpdir(), `queue-relay-backoff-test-${crypto.randomUUID()}`);
    tmpDirs.push(tmpDir);
    mkdirSync(tmpDir, { recursive: true });
    const relay = await startFakeRelay(behaviour);
    writeFileSync(join(tmpDir, 'plugin.js'), "export default { source: 'test', mapEvent: () => null };");
    writeFileSync(
      join(tmpDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${relay.port}\ntoken: t\nplugins:\n  - module: ${join(tmpDir, 'plugin.js')}\n    subscriptions:\n      - eventType: [test]\n`
    );
    const asked: number[] = [];
    const connection: RelayConnection = new RelayConnection({
      configDir: tmpDir,
      retryDelayMs: 1,
      reconnect: { minMs: 1_000, maxMs: 30_000, random: () => 0.5, ...SPECIAL, ...reconnect },
      sleep: (ms) => {
        asked.push(ms);
        if (asked.length >= count) {
          connection.stop();
        }
        return Promise.resolve();
      },
    });
    try {
      await connection.start();
    } finally {
      await relay.close();
    }
    return { asked, lastError: connection.getDiagnostics().lastError };
  }

  it('grows exponentially from minMs and stops growing at maxMs', async () => {
    const asked = await delaysAsked({ kind: 'ws-drop' }, 8, { minMs: 1_000, maxMs: 30_000, random: () => 0.5 });
    expect(asked).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('the jitter spans 0.8x to 1.2x of every step', async () => {
    const low = await delaysAsked({ kind: 'ws-drop' }, 4, { random: () => 0 });
    expect(low).toEqual([800, 1_600, 3_200, 6_400]);
    const high = await delaysAsked({ kind: 'ws-drop' }, 4, { random: () => 1 });
    expect(high).toEqual([1_200, 2_400, 4_800, 9_600]);
  });

  it('a step under minMs is lifted to minMs first (the floor), then growth continues above it', async () => {
    const asked = await delaysAsked({ kind: 'ws-drop' }, 5, { minMs: 5_000, maxMs: 30_000, random: () => 0.5 });
    expect(asked).toEqual([5_000, 5_000, 5_000, 8_000, 16_000]);
  });

  it.each([
    ['4400 (protocol error)', { kind: 'ws-close', code: 4400 } as FakeRelay, SPECIAL.abuseMs],
    ['1013 (try again later)', { kind: 'ws-close', code: 1013 } as FakeRelay, SPECIAL.tryAgainMs],
    ['4429 (too many failed authentications)', { kind: 'ws-close', code: 4429 } as FakeRelay, SPECIAL.authBlockedMs],
    ['HTTP 429 on the upgrade', { kind: 'http', status: 429 } as FakeRelay, SPECIAL.authBlockedMs],
  ])('%s -> the dedicated delay, exactly, on every attempt (no jitter, no exponential growth)', async (_name, behaviour, expected) => {
    const asked = await delaysAsked(behaviour, 3, { random: () => 0.9 });
    expect(asked).toEqual([expected, expected, expected]);
  });

  it.each([
    ['4400', 4400],
    ['1013', 1013],
    ['4429', 4429],
  ])('after a %s the dedicated delay is used once: the next ordinary drop is back on the exponential backoff', async (_name, code) => {
    const asked = await delaysAsked({ kind: 'ws-script', steps: [code, 'drop'] }, 4, { random: () => 0.5 });
    const dedicated = { 4400: SPECIAL.abuseMs, 1013: SPECIAL.tryAgainMs, 4429: SPECIAL.authBlockedMs }[code];
    expect(asked).toEqual([dedicated, 1_000, 2_000, 4_000]);
  });

  it.each([
    ['4400', 4400, { abuseMs: 90_000 }, 'protocol error (4400); backing off 2 min'],
    ['1013', 1013, { tryAgainMs: 1_500 }, 'temporarily unavailable (1013); backing off 2s'],
    ['4429', 4429, { authBlockedMs: 90_000 }, '(4429): backing off 2 min'],
  ])('the %s message rounds the delay up (a delay of 1.5 units says 2, never 1)', async (_name, code, reconnect, expected) => {
    const { lastError } = await scenario({ kind: 'ws-close', code }, 1, reconnect);
    expect(lastError).toContain(expected);
  });

  it('HTTP 503 on the upgrade uses the normal exponential backoff, not the 429 delay', async () => {
    const asked = await delaysAsked({ kind: 'http', status: 503 }, 3, { random: () => 0.5 });
    expect(asked).toEqual([1_000, 2_000, 4_000]);
  });
});
