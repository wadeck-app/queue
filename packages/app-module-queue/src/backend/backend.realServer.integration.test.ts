import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addProject, removeProject } from '@wadeck-app/project-sdk';

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
// The project registry the server reads (XDG_CONFIG_HOME/project), and the ids of the projects written in it
let registryDir: string;
let appProjectId: string;
let deletedProjectId: string;

function writeHistory(): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const records = [
    // cwd is the module dir, which exists, so a replay gets past the cwd check and stops at the missing daemon.
    { type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'evt-with-payload', event: 'onFoo', matchedCount: 0, totalCount: 0, payload: { a: 1 }, cwd: packageDir },
    { type: 'trigger', ts: '2026-01-01T00:00:01.000Z', eventId: 'evt-no-payload', event: 'onFoo', matchedCount: 0, totalCount: 0 },
  ];
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Log files for the log-files routes, in the logs directory only (writeRecent deletes the history files it does not know)
const OLD_DAEMON_LOG = '2026-01-02.ndjson';
const OLD_LAUNCHER_LOG = '2026-01-02-launcher.log';
const OLD_DELETABLE_LOG = '2026-01-03.ndjson';
const SENTINEL = 'sentinel-outside-the-log-dir.txt';

function utcDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function writeLogFixtures(): void {
  const logs = join(configDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const longAgo = new Date(Date.now() - 400 * 86_400_000);
  for (const name of [OLD_DAEMON_LOG, OLD_LAUNCHER_LOG, OLD_DELETABLE_LOG]) {
    writeFileSync(join(logs, name), 'x'.repeat(2048));
    utimesSync(join(logs, name), longAgo, longAgo);
  }
  // Within the retention: a prune must keep it
  const recent = join(logs, `${utcDay(5)}.ndjson`);
  writeFileSync(recent, 'y'.repeat(100));
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
  utimesSync(recent, fiveDaysAgo, fiveDaysAgo);
  // Today's file: the module also writes its audit lines in it
  writeFileSync(join(logs, `${utcDay(0)}.ndjson`), '{}\n');
  writeFileSync(join(configDir, SENTINEL), 'keep me');
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
      env: { ...process.env, APP_CORE_PORT: '0', QUEUE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(workDir, 'xdg') },
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
    writeLogFixtures();
    registryDir = join(workDir, 'xdg', 'project');
    mkdirSync(join(workDir, 'app-folder'));
    appProjectId = (await addProject(registryDir, { name: 'app', path: join(workDir, 'app-folder') })).id;
    deletedProjectId = (await addProject(registryDir, { name: 'gone' })).id;
    await removeProject(registryDir, deletedProjectId);
    packageModule(builtModule);
    baseUrl = await startServer(builtModule);
  });

  afterAll(async () => {
    // Wait for the server to be gone: on Windows it still holds its files for a moment after kill(), and the removal below then fails with EPERM
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/api/modules/queue${path}`, {
      method,
      ...(init.headers !== undefined && { headers: init.headers }),
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
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

  it('GET /related/project/:projectId answers 200 with the card of a registered project', async () => {
    const { status, body } = await call('GET', `/related/project/${appProjectId}`);
    expect(status).toBe(200);
    expect(body).toEqual({ title: 'Queue', count: 0, countLabel: 'pending or in the dead-letter queue', items: [], moreUrl: `/modules/queue/history?project=${appProjectId}` });
  });

  it('GET /related/project/:projectId answers 200 for a soft-deleted project', async () => {
    expect((await call('GET', `/related/project/${deletedProjectId}`)).status).toBe(200);
  });

  it('GET /related/project/:projectId answers 404 with { error } naming an unknown id, and 400 with { error } for a malformed one', async () => {
    const unknown = await call('GET', '/related/project/deadbeef');
    expect(unknown.status).toBe(404);
    expect(String(unknown.body['error'])).toContain('deadbeef');
    const malformed = await call('GET', '/related/project/not-an-id');
    expect(malformed.status).toBe(400);
    expect(String(malformed.body['error'])).toContain('not-an-id');
  });

  it('GET /project-scope reads the ?project= query: found for a registered or deleted project, found false (200) for anything else', async () => {
    expect(await call('GET', `/project-scope?project=${appProjectId}`)).toEqual({ status: 200, body: { id: appProjectId, name: 'app', found: true } });
    expect(await call('GET', `/project-scope?project=${deletedProjectId}`)).toEqual({ status: 200, body: { id: deletedProjectId, name: 'gone', found: true } });
    expect(await call('GET', '/project-scope?project=deadbeef')).toEqual({ status: 200, body: { id: 'deadbeef', name: '', found: false } });
    expect(await call('GET', '/project-scope')).toEqual({ status: 200, body: { id: '', name: '', found: false } });
  });

  it('GET /api/slots/queue:project-header answers an empty list when no module contributes, so the ExtensionSlot of the pages renders nothing', async () => {
    const response = await fetch(`${baseUrl}/api/slots/queue:project-header`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
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

  describe('log files', () => {
    const logsDir = (): string => join(configDir, 'logs');
    const sentinelIntact = (): boolean => existsSync(join(configDir, SENTINEL)) && readFileSync(join(configDir, SENTINEL), 'utf8') === 'keep me';

    it('GET /log-files lists the files with the status of each, today protected, wal and dlq as information', async () => {
      const { status, body } = await call('GET', '/log-files');
      expect(status).toBe(200);
      const logs = body['logs'] as { files: Array<{ name: string; status: string; canDelete: boolean }>; prunableCount: number };
      const byName = new Map(logs.files.map((f) => [f.name, f]));
      expect(byName.get(OLD_DAEMON_LOG)).toMatchObject({ status: 'prune', canDelete: true });
      expect(byName.get(`${utcDay(5)}.ndjson`)).toMatchObject({ status: 'kept', canDelete: true });
      expect(byName.get(`${utcDay(0)}.ndjson`)).toMatchObject({ status: 'protected', canDelete: false });
      expect(logs.prunableCount).toBeGreaterThanOrEqual(3);
      expect((body['queueFiles'] as Array<{ name: string }>).map((q) => q.name)).toEqual(['wal.ndjson', 'dlq.ndjson']);
    });

    it('POST /log-files/:kind/:day/:variant/delete deletes an old file, answers a message, and deleting it again is an idempotent 200', async () => {
      const day = OLD_DELETABLE_LOG.slice(0, 10);
      const first = await call('POST', `/log-files/logs/${day}/daemon/delete`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ deleted: true, file: OLD_DELETABLE_LOG });
      expect(String(first.body['message'])).toContain(OLD_DELETABLE_LOG);
      expect(existsSync(join(logsDir(), OLD_DELETABLE_LOG))).toBe(false);
      const second = await call('POST', `/log-files/logs/${day}/daemon/delete`);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ deleted: false });
      expect(String(second.body['message'])).toContain('already gone');
    });

    it("POST delete of today's file is a 409 and the file stays", async () => {
      const { status, body } = await call('POST', `/log-files/logs/${utcDay(0)}/daemon/delete`);
      expect(status).toBe(409);
      expect(String(body['error'])).toContain('protected');
      expect(existsSync(join(logsDir(), `${utcDay(0)}.ndjson`))).toBe(true);
    });

    it.each([
      ['an encoded slash in the day', '/log-files/logs/..%2F..%2Fsentinel/daemon/delete'],
      ['a double-encoded slash', '/log-files/logs/..%252F..%252Fsentinel/daemon/delete'],
      ['an encoded backslash', '/log-files/logs/..%5C..%5Csentinel/daemon/delete'],
      ['a NUL byte', '/log-files/logs/2026-01-02%00/daemon/delete'],
      ['a very long segment', `/log-files/logs/${'a'.repeat(5000)}/daemon/delete`],
      ['an impossible date (2026-02-30)', '/log-files/logs/2026-02-30/daemon/delete'],
      ['an unknown kind', '/log-files/wal/2026-01-02/daemon/delete'],
      ['an unknown kind in the traversal position', '/log-files/..%2F/2026-01-02/daemon/delete'],
      ['an unknown variant', '/log-files/logs/2026-01-02/other/delete'],
      ['the history launcher combination', '/log-files/history/2026-01-02/launcher/delete'],
    ])('POST delete with %s is never a 200 and touches no file outside the log directory', async (_label, path) => {
      const { status, body } = await call('POST', path);
      expect(status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(status, JSON.stringify(body)).toBeLessThan(500);
      expect(typeof body['error']).toBe('string');
      expect(sentinelIntact()).toBe(true);
      expect(existsSync(join(logsDir(), OLD_DAEMON_LOG))).toBe(true);
    });

    it('POST prune with an unknown kind is a 400 that names the choices', async () => {
      const { status, body } = await call('POST', '/log-files/wal/prune');
      expect(status).toBe(400);
      expect(String(body['error'])).toContain('kind must be one of logs, history');
    });

    it.each(['cross-site', 'same-site'])('both POST routes refuse a browser request started by another site (Sec-Fetch-Site: %s) with a 403 and delete nothing', async (site) => {
      const headers = { 'Sec-Fetch-Site': site };
      const prune = await call('POST', '/log-files/logs/prune', { headers });
      const del = await call('POST', `/log-files/logs/${OLD_DAEMON_LOG.slice(0, 10)}/daemon/delete`, { headers });
      expect([prune.status, del.status]).toEqual([403, 403]);
      expect(String(del.body['error'])).toContain('another site');
      expect(existsSync(join(logsDir(), OLD_DAEMON_LOG))).toBe(true);
    });

    it('accepts Sec-Fetch-Site: same-origin (the dashboard itself) on the delete route', async () => {
      // A file that is already gone: proves the request got past the guard without needing a fixture
      const { status, body } = await call('POST', '/log-files/logs/2026-01-09/daemon/delete', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
      expect(status).toBe(200);
      expect(body['deleted']).toBe(false);
    });

    it('POST /log-files/logs/prune removes only the files past the retention, keeps recent and today, and reports the freed size', async () => {
      const { status, body } = await call('POST', '/log-files/logs/prune');
      expect(status).toBe(200);
      const deleted = (body['deleted'] as Array<{ file: string }>).map((d) => d.file).sort();
      expect(deleted).toEqual([OLD_DAEMON_LOG, OLD_LAUNCHER_LOG].sort());
      expect(String(body['message'])).toContain('Deleted 2 log files');
      expect(readdirSync(logsDir())).toEqual(expect.arrayContaining([`${utcDay(5)}.ndjson`, `${utcDay(0)}.ndjson`]));
      expect(existsSync(join(logsDir(), OLD_DAEMON_LOG))).toBe(false);
      expect(sentinelIntact()).toBe(true);
      // The history is another directory: its files are untouched
      expect(existsSync(join(configDir, 'history', '2026-01-01.ndjson'))).toBe(true);
    });
  });
});
