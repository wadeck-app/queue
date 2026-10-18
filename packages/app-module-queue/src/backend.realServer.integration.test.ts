import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Calls the parameterised routes (`/history/:eventId`, `/history/:eventId/replay`, `/dlq/:id/...`)
 * through a REAL app-core server (`app-core-cli dev` boots app-core's own buildServer), because
 * backend.test.ts calls the handlers directly and so cannot see how the router fills `req.params`.
 * app-core < 2026.10.17-023 matched routes by exact string: `/history/:eventId` answered 404 and
 * the handler received `params.eventId === undefined`.
 *
 * Needs the global `app-core-cli` binary (skipped, with the reason, when it is not on the PATH) and the
 * built backend (`npm run build`).
 */

const IS_WINDOWS = process.platform === 'win32';
const moduleDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_START_TIMEOUT_MS = 30_000;

const cliVersion = spawnSync('app-core-cli', ['version'], { shell: IS_WINDOWS, encoding: 'utf8', windowsHide: true });
const cliMissing = cliVersion.error !== undefined || cliVersion.status !== 0;
if (cliMissing) {
  console.warn('[backend.realServer.integration] SKIPPED: "app-core-cli" is not runnable from the PATH, so the real-server route tests did not run. Install it globally (@wadeck-app/app-core-cli) to run them.');
}

let child: ChildProcess;
let configDir: string;
let baseUrl: string;

function writeHistory(): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const records = [
    // cwd is the module dir, which exists, so a replay gets past the cwd check and stops at the missing daemon.
    { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'evt-with-payload', event: 'onFoo', matchedCount: 0, totalCount: 0, payload: { a: 1 }, cwd: moduleDir },
    { type: 'trigger', ts: '2026-01-01T00:00:01.000Z', eventId: 'evt-no-payload', event: 'onFoo', matchedCount: 0, totalCount: 0 },
  ];
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function stopServer(): void {
  if (child?.pid === undefined) {
    return;
  }
  if (IS_WINDOWS) {
    // The shim runs node through cmd.exe: kill the whole tree, not just the shell.
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill();
  }
}

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`app-core-cli dev did not print its URL within ${SERVER_START_TIMEOUT_MS} ms. Output so far:\n${output}`)),
      SERVER_START_TIMEOUT_MS,
    );
    child = spawn('app-core-cli', ['dev', moduleDir], {
      shell: IS_WINDOWS,
      windowsHide: true,
      // Port 0: a free port, never the developer's real app-core on 4850. QUEUE_CONFIG_DIR: the fixture history.
      env: { ...process.env, APP_CORE_PORT: '0', QUEUE_CONFIG_DIR: configDir },
    });
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`app-core-cli dev exited early (code ${code}). Output:\n${output}`));
    });
  });
}

describe.skipIf(cliMissing)('parameterised routes through a real app-core server', () => {
  beforeAll(async () => {
    if (!existsSync(join(moduleDir, 'api-backend/dist/backend.js'))) {
      throw new Error('api-backend/dist/backend.js is missing: run "npm run build" before this test.');
    }
    configDir = mkdtempSync(join(tmpdir(), 'app-module-queue-real-server-'));
    writeHistory();
    baseUrl = await startServer();
  }, SERVER_START_TIMEOUT_MS + 5_000);

  afterAll(() => {
    stopServer();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function call(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/api/modules/queue${path}`, { method });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('GET /history/:eventId hands the real eventId to the handler and returns the entry', async () => {
    const { status, body } = await call('GET', '/history/evt-with-payload');
    expect(status).toBe(200);
    expect(body['eventId']).toBe('evt-with-payload');
    expect(body['payload']).toEqual({ a: 1 });
  });

  it('GET /history/:eventId answers 404 with the unknown id in the message (not "undefined")', async () => {
    const { status, body } = await call('GET', '/history/nope');
    expect(status).toBe(404);
    expect(body['error']).toBe('No history entry for eventId nope');
  });

  it('GET /history (static) still wins over the parameterised route', async () => {
    const { status, body } = await call('GET', '/history?limit=1');
    expect(status).toBe(200);
    expect(body['total']).toBe(2);
  });

  it('POST /history/:eventId/replay gets the eventId: unknown id is a 404 naming it', async () => {
    const { status, body } = await call('POST', '/history/nope/replay');
    expect(status).toBe(404);
    expect(body['error']).toBe('No history entry found for eventId nope');
  });

  it('POST /history/:eventId/replay gets the eventId: an entry without payload is a 422 naming it', async () => {
    const { status, body } = await call('POST', '/history/evt-no-payload/replay');
    expect(status).toBe(422);
    expect(String(body['error'])).toContain('evt-no-payload');
  });

  it('POST /history/:eventId/replay reaches the daemon check for a replayable entry (503, no daemon in this test)', async () => {
    const { status, body } = await call('POST', '/history/evt-with-payload/replay');
    expect(status).toBe(503);
    expect(String(body['error'])).toContain('Daemon is not running');
  });

  it('POST /dlq/:id/replay is routed to the handler (503 from the missing daemon: it runs the subscriber), not rejected as not-found by the router', async () => {
    const { status, body } = await call('POST', '/dlq/some-id/replay');
    expect(status).toBe(503);
    expect(body['error']).not.toBe('not-found');
    expect(String(body['error'])).toContain('Daemon is not running');
  });

  it('POST /dlq/:id/clear gets the id and works without any daemon (it edits the DLQ file): an unknown id clears 0', async () => {
    const { status, body } = await call('POST', '/dlq/some-id/clear');
    expect(status).toBe(200);
    expect(body['cleared']).toBe(0);
  });

  it('the read routes work without any daemon', async () => {
    const status = await call('GET', '/status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ pendingCount: 0, dlqCount: 0 });

    const dlq = await call('GET', '/dlq');
    expect(dlq.status).toBe(200);
    expect(dlq.body['entries']).toEqual([]);

    const subscribers = await call('GET', `/subscribers?cwd=${encodeURIComponent(configDir)}`);
    expect(subscribers.status).toBe(200);
    expect(subscribers.body['subscribers']).toEqual([]);
  });
});
