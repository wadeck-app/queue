import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Builds the module with `app-core-cli package` and serves the result through a REAL app-core server
 * (`app-core-cli dev` boots app-core's own buildServer), then calls the routes over HTTP. backend.test.ts calls
 * the handlers directly, so it cannot see how the router fills `req.params` (app-core < 2026.10.17-023 answered
 * `/history/:eventId` with 404), nor whether the packaged CJS bundle loads and runs.
 *
 * Uses the app-core-cli installed as a devDependency of this package (not a global binary), so it runs in CI too.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Guards against a child that HANGS, never performance limits: no test may fail because the machine is slow.
const SERVER_START_TIMEOUT_MS = 300_000;
const PACKAGE_TIMEOUT_MS = 300_000;

const cliPackageJson = createRequire(import.meta.url).resolve('@wadeck-app/app-core-cli/package.json');
const cliEntry = join(dirname(cliPackageJson), 'dist/cli.bundle.js');

let child: ChildProcess;
let workDir: string;
let configDir: string;
let baseUrl: string;

function writeHistory(): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const records = [
    // cwd is the module dir, which exists, so a replay gets past the cwd check and stops at the missing daemon.
    { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'evt-with-payload', event: 'onFoo', matchedCount: 0, totalCount: 0, payload: { a: 1 }, cwd: packageDir },
    { type: 'trigger', ts: '2026-01-01T00:00:01.000Z', eventId: 'evt-no-payload', event: 'onFoo', matchedCount: 0, totalCount: 0 },
  ];
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * One event pushed just now: the activity counters count it in every window (the January ones are older than 24 h). Written by the
 * tests that need it right before they ask, so the time between the write and the question is milliseconds, never the minutes a
 * slow start-up could add.
 */
function writeRecent(): void {
  // A previous call may have written it under the day before a midnight: keep exactly one recent record
  for (const file of readdirSync(join(configDir, 'history'))) {
    if (file !== '2026-01-01.ndjson') {
      rmSync(join(configDir, 'history', file));
    }
  }
  const now = new Date();
  const recent = { type: 'trigger', ts: now.toISOString(), eventId: 'evt-recent', event: 'onFoo', matchedCount: 0, totalCount: 0 };
  writeFileSync(join(configDir, 'history', `${now.toISOString().slice(0, 10)}.ndjson`), JSON.stringify(recent) + '\n');
}

/** `app-core-cli package` into a folder outside the module (check refuses any other folder at the module root). */
function packageModule(out: string): void {
  try {
    execFileSync(process.execPath, [cliEntry, 'package', packageDir, '--out', out, '--version', '0.0.0-test-real-server'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PACKAGE_TIMEOUT_MS, windowsHide: true,
    });
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string };
    throw new Error(`app-core-cli package failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

function startServer(builtModule: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`app-core-cli dev did not print its URL within ${SERVER_START_TIMEOUT_MS} ms (hung?). Output so far:\n${output}`)),
      SERVER_START_TIMEOUT_MS,
    );
    // node + the CLI file, no shell: child.kill() reaches the real server process
    child = spawn(process.execPath, [cliEntry, 'dev', builtModule], {
      windowsHide: true,
      // Port 0: a free port, never the developer's real app-core on 4850. QUEUE_CONFIG_DIR: the fixture history.
      env: { ...process.env, APP_CORE_PORT: '0', QUEUE_CONFIG_DIR: configDir },
    });
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /app-core-cli dev: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
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

describe('the packaged module through a real app-core server', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'app-module-queue-real-server-'));
    configDir = join(workDir, 'queue-config');
    const builtModule = join(workDir, 'module');
    writeHistory();
    packageModule(builtModule);
    baseUrl = await startServer(builtModule);
  });

  afterAll(() => {
    child?.kill();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('GET /activity counts the events pushed in the last 5 min, 60 min and 24 h', async () => {
    writeRecent();
    const { status, body } = await call('GET', '/activity');
    expect(status).toBe(200);
    expect(body).toEqual({ last5Min: 1, last60Min: 1, last24Hours: 1 });
  });

  it('GET /history (static) still wins over the parameterised route', async () => {
    writeRecent();
    const { status, body } = await call('GET', '/history?limit=1');
    expect(status).toBe(200);
    // the two January events plus the recent one written for the activity counters
    expect(body['total']).toBe(3);
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
