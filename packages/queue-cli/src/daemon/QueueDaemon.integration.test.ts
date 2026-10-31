import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryReader, getQueueProtocolInfo } from '@wadeck-app/queue-core';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { startDaemon } from './QueueDaemon.js';
import { waitFor } from '../testWaitFor.js';

// Reads a file once the daemon wrote it
const waitForFile = (path: string): Promise<string> => waitFor(() => (existsSync(path) ? readFileSync(path, 'utf8') : undefined), path + ' to appear');

// The real daemon (kit + queue service) on a free port in a throwaway config dir: what an SDK or any HTTP client meets.

interface Answer {
  status: number;
  body: unknown;
}

function call(port: number, method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? '' : JSON.stringify(options.body);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data === '' ? null : JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const RELEASE = '2026.10.24-test-1';

describe('queue daemon over HTTP', () => {
  let configDir: string;
  let projectDir: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-daemon-it-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'queue-daemon-it-project-'));
    await startDaemon(configDir, { port: 0, version: RELEASE });
    port = (JSON.parse(await waitForFile(join(configDir, 'config.port'))) as { port: number }).port;
    token = (await waitForFile(join(configDir, 'health_token'))).trim();
  });

  afterAll(async () => {
    await call(port, 'POST', '/quit', { token });
    // the daemon removes its port file on a clean stop: wait for it before deleting the directory
    await waitFor(() => !existsSync(join(configDir, 'config.port')), 'the daemon to remove its port file after /quit');
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('advertises its push protocol in GET /version, without a token', async () => {
    const answer = await call(port, 'GET', '/version');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ pid: process.pid, queueProtocol: getQueueProtocolInfo() });
  });

  it('reports the queue release it was started from, not the daemon library default', async () => {
    const answer = await call(port, 'GET', '/version');
    expect(answer.body).toMatchObject({ version: RELEASE });
  });

  it('refuses a push without the token', async () => {
    const answer = await call(port, 'POST', '/push', { body: { event: 'it.noauth', payload: {}, cwd: projectDir } });
    expect(answer.status).toBe(401);
  });

  it('queues a push that does not say its protocol (every client that exists today)', async () => {
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.legacy', payload: {}, cwd: projectDir } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'queued', subscriberCount: 0 } });
  });

  it('queues a push that speaks the current protocol', async () => {
    const { version } = getQueueProtocolInfo();
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.current', payload: {}, cwd: projectDir, protocol: version } });
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'queued' } });
  });

  it('answers a push of an unaccepted protocol MAJOR with rejected and the accepted range', async () => {
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.future', payload: {}, cwd: projectDir, protocol: '9.0.0' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'rejected', supported: getQueueProtocolInfo().accepts } });
  });
});

describe('queue daemon: a type: action subscriber emits an event (end to end over HTTP)', () => {
  let configDir: string;
  let projectDir: string;
  let xdgDir: string;
  let previousXdg: string | undefined;
  let projectId: string;
  let port: number;
  let token: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-daemon-action-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'queue-daemon-action-project-'));
    // The daemon reads the project registry from XDG_CONFIG_HOME: a throwaway one, so the test sees (and touches) nothing of the machine
    xdgDir = mkdtempSync(join(tmpdir(), 'queue-daemon-action-xdg-'));
    previousXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = xdgDir;
    const registryDir = join(xdgDir, 'project');
    const project = await addProject(registryDir, { name: 'action-app', path: projectDir });
    projectId = project.id;
    writeFileSync(
      join(projectToolDir(registryDir, projectId, 'queue', 'config', { ensure: true }), 'subscribers.yml'),
      [
        'subscribers:',
        '  it.source:',
        '    - type: action',
        '      name: relay',
        '      action: emit',
        '      with:',
        '        event: it.emitted',
        '        payload:',
        '          text: "{{ payload.text }}"',
        '          from: "queue:{{ event }}"',
        '          ref: "{{ id }}"',
        '  it.emitted:',
        '    - type: action',
        '      name: relay2',
        '      action: emit',
        '      with:',
        '        event: it.final',
        '        payload: { text: "{{ payload.text }}" }',
        '',
      ].join('\n'),
    );
    await startDaemon(configDir, { port: 0, version: RELEASE });
    port = (JSON.parse(await waitForFile(join(configDir, 'config.port'))) as { port: number }).port;
    token = (await waitForFile(join(configDir, 'health_token'))).trim();
  });

  afterAll(async () => {
    await call(port, 'POST', '/quit', { token });
    await waitFor(() => !existsSync(join(configDir, 'config.port')), 'the daemon to remove its port file after /quit');
    if (previousXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = previousXdg;
    }
    for (const dir of [configDir, projectDir, xdgDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('runs the builtin emit action in the daemon, files the emitted events under the project of the source event and chains a second hop', async () => {
    const answer = await call(port, 'POST', '/push', { token, body: { event: 'it.source', payload: { text: 'hello' }, cwd: projectDir } });
    expect(answer.body).toMatchObject({ ok: true, result: { status: 'queued', subscriberCount: 1 } });
    const sourceId = (answer.body as { result: { eventId: string } }).result.eventId;

    const history = new HistoryReader(join(configDir, 'history'));
    const emitted = await waitFor(() => {
      const found = history.read({ event: 'it.emitted' });
      return found.length === 1 && found[0]!.subscribers.some((sub) => sub.status === 'success') ? found[0] : undefined;
    }, 'the emitted event it.emitted to be recorded with its own action delivered');
    const final = await waitFor(() => {
      const found = history.read({ event: 'it.final' });
      return found.length === 1 ? found[0] : undefined;
    }, 'the second hop it.final to be recorded');

    // The source event: its action subscriber ended as a success, shown as action:emit
    const source = history.read({ event: 'it.source' });
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ eventId: sourceId, projectId });
    expect(source[0]!.subscribers).toEqual([expect.objectContaining({ subscriberId: `${projectId}/relay`, status: 'success', target: 'action:emit' })]);

    // Attribution: each emitted event belongs to the project of the event that fired the action, with the payload rendered ({{ id }} = id of the source push)
    expect(emitted).toMatchObject({ projectId, payload: { text: 'hello', from: 'queue:it.source', ref: sourceId } });
    expect(emitted!.subscribers).toEqual([expect.objectContaining({ subscriberId: `${projectId}/relay2`, status: 'success', target: 'action:emit' })]);
    expect(final).toMatchObject({ projectId, payload: { text: 'hello' } });
  });

  it('logs what emit did (the emitted event id) in the dispatch log', async () => {
    const history = new HistoryReader(join(configDir, 'history'));
    const emitted = history.read({ event: 'it.emitted' })[0]!;
    const logsDir = join(configDir, 'logs');
    const logs = readdirSync(logsDir).map((name) => readFileSync(join(logsDir, name), 'utf8')).join('\n');
    expect(logs).toContain(`emitted 'it.emitted' (${emitted.eventId})`);
  });
});
