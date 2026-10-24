import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonResolver, locateDaemon, readToken, sameDirectory, type DaemonDeps } from './daemon.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type { HttpOutcome, LoopbackRequest } from './http.js';
import { closedPort, makeTempDir, removeDir, startFakeDaemon, type FakeDaemon } from './testing/fakeDaemon.js';

let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeDir(dir);
});

function writePortFile(content: string): void {
  writeFileSync(join(dir, 'config.port'), content);
}

describe('locateDaemon', () => {
  it('is absent without a port file and names the path', () => {
    const located = locateDaemon(dir);
    expect(located.state).toBe('absent');
    expect(located.path).toBe(join(dir, 'config.port'));
  });

  it('is absent when the config dir does not exist', () => {
    expect(locateDaemon(join(dir, 'nope')).state).toBe('absent');
  });

  it('reads port and pid', () => {
    writePortFile(JSON.stringify({ sdkVersion: 1, port: 47910, pid: 123, startedAt: 'now' }));
    expect(locateDaemon(dir)).toMatchObject({ state: 'found', file: { port: 47910, pid: 123 } });
  });

  it('tolerates a trailing newline and a BOM', () => {
    writePortFile(`\uFEFF${JSON.stringify({ port: 1, pid: 2 })}\r\n`);
    expect(locateDaemon(dir).state).toBe('found');
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an empty file', ''],
    ['a JSON array', '[]'],
    ['a missing port', JSON.stringify({ pid: 1 })],
    ['a missing pid', JSON.stringify({ port: 1 })],
    ['a string port', JSON.stringify({ port: '1', pid: 1 })],
    ['a port out of range', JSON.stringify({ port: 70000, pid: 1 })],
    ['a non-integer pid', JSON.stringify({ port: 1, pid: 1.5 })],
  ])('reports %s as corrupt with the file path', (_name, content) => {
    writePortFile(content);
    const located = locateDaemon(dir);
    expect(located.state).toBe('corrupt');
    expect(located.path).toBe(join(dir, 'config.port'));
    expect(located.state === 'corrupt' && located.reason).toContain(join(dir, 'config.port'));
  });
});

describe('readToken', () => {
  it('trims the token', () => {
    writeFileSync(join(dir, 'health_token'), 'abc123\r\n');
    expect(readToken(dir)).toEqual({ ok: true, token: 'abc123' });
  });

  it('reports a missing file with its path and the QUEUE_CONFIG_DIR hint', () => {
    const result = readToken(dir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(join(dir, 'health_token'));
    expect(!result.ok && result.reason).toContain('QUEUE_CONFIG_DIR');
  });

  it('reports an empty file', () => {
    writeFileSync(join(dir, 'health_token'), '  \n');
    const result = readToken(dir);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('empty');
  });

  it('reports a directory in place of the file', () => {
    mkdirSync(join(dir, 'health_token'));
    expect(readToken(dir).ok).toBe(false);
  });
});

describe('sameDirectory', () => {
  it('ignores a trailing separator and relative segments', () => {
    expect(sameDirectory(join(dir, 'a', '..', 'b'), join(dir, 'b') + '/', 'linux')).toBe(true);
  });

  it('is case-insensitive on win32 only', () => {
    const windowsPath = (...parts: string[]): string => parts.join('\\');
    expect(sameDirectory(windowsPath('C:', 'Users', 'Me', 'q'), windowsPath('c:', 'users', 'me', 'Q'), 'win32')).toBe(true);
    expect(sameDirectory('/home/Me/q', '/home/me/q', 'linux')).toBe(false);
  });

  it('tells different directories apart', () => {
    expect(sameDirectory('/a/b', '/a/c', 'linux')).toBe(false);
  });
});

interface Script {
  calls: LoopbackRequest[];
  deps: DaemonDeps;
}

function scripted(outcome: HttpOutcome, alive = true): Script {
  const calls: LoopbackRequest[] = [];
  return {
    calls,
    deps: {
      request: (options) => {
        calls.push(options);
        return Promise.resolve(outcome);
      },
      isPidAlive: () => alive,
      platform: 'linux',
    },
  };
}

function versionAnswer(extra: Record<string, unknown> = {}, pid = 4242, configDir = dir): HttpOutcome {
  return { kind: 'response', status: 200, text: JSON.stringify({ version: '1.2.3', pid, config_dir: configDir, sdkVersion: 1, port: 47910, ...extra }) };
}

function seedFiles(pid = 4242, port = 47910): void {
  writePortFile(JSON.stringify({ sdkVersion: 1, port, pid, startedAt: 'now' }));
  writeFileSync(join(dir, 'health_token'), 'tok\n');
}

describe('createDaemonResolver', () => {
  it('is stopped without a port file', async () => {
    const { deps, calls } = scripted(versionAnswer());
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'stopped', cause: 'no-port-file' });
    expect(calls).toHaveLength(0);
  });

  it('is stopped with the file path when the port file is corrupt', async () => {
    writePortFile('{nope');
    const { deps } = scripted(versionAnswer());
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'stopped', cause: 'corrupt-port-file' });
    expect(result.state === 'stopped' && result.reason).toContain(join(dir, 'config.port'));
  });

  it('is ready when /version matches the port file, and asks without a token', async () => {
    seedFiles();
    const { deps, calls } = scripted(versionAnswer());
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'ready', daemon: { port: 47910, pid: 4242, version: '1.2.3', protocol: { version: '1.0.0', accepts: '^1.0.0' }, negotiated: PROTOCOL_VERSION } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ port: 47910, method: 'GET', path: '/version' });
    expect(calls[0]?.headers?.['Authorization']).toBeUndefined();
  });

  it('is stopped (process-gone) when nothing answers and the pid is dead', async () => {
    seedFiles();
    const { deps } = scripted({ kind: 'failure', message: 'refused', code: 'ECONNREFUSED', connected: false, timedOut: false }, false);
    expect(await createDaemonResolver(dir, deps).resolve()).toMatchObject({ state: 'stopped', cause: 'process-gone' });
  });

  it('is stopped (not-answering) when nothing answers although the pid is alive', async () => {
    seedFiles();
    const { deps } = scripted({ kind: 'failure', message: 'timeout', connected: true, timedOut: true }, true);
    expect(await createDaemonResolver(dir, deps).resolve()).toMatchObject({ state: 'stopped', cause: 'not-answering' });
  });

  it('treats a different pid on the port as a stale file, even if the recorded pid is dead', async () => {
    seedFiles(4242);
    const { deps } = scripted(versionAnswer({}, 9999), false);
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'stopped', cause: 'stale-port-file' });
    expect(result.state === 'stopped' && result.reason).toContain('9999');
    expect(result.state === 'stopped' && result.reason).toContain('4242');
  });

  it('treats a different config_dir as a stale file', async () => {
    seedFiles();
    const { deps } = scripted(versionAnswer({}, 4242, join(dir, 'other')));
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'stopped', cause: 'stale-port-file' });
    expect(result.state === 'stopped' && result.reason).toContain('other');
  });

  it.each([
    ['a non-200 status', { kind: 'response', status: 500, text: 'boom' } as HttpOutcome],
    ['a non-JSON body', { kind: 'response', status: 200, text: '<html>' } as HttpOutcome],
    ['a body without pid', { kind: 'response', status: 200, text: JSON.stringify({ config_dir: 'x' }) } as HttpOutcome],
  ])('treats %s as another program on the port', async (_name, outcome) => {
    seedFiles();
    const { deps } = scripted(outcome);
    expect(await createDaemonResolver(dir, deps).resolve()).toMatchObject({ state: 'stopped', cause: 'stale-port-file' });
  });

  it('reports an incompatible daemon with both versions', async () => {
    seedFiles();
    const { deps } = scripted(versionAnswer({ queueProtocol: { version: '2.0.0', accepts: '^2.0.0' } }));
    const result = await createDaemonResolver(dir, deps).resolve();
    expect(result).toMatchObject({ state: 'incompatible' });
    expect(result.state === 'incompatible' && result.reason).toContain('2.0.0');
    expect(result.state === 'incompatible' && result.reason).toContain('1.0.0');
  });

  it('reports a malformed queueProtocol as incompatible', async () => {
    seedFiles();
    const { deps } = scripted(versionAnswer({ queueProtocol: { version: 3 } }));
    expect(await createDaemonResolver(dir, deps).resolve()).toMatchObject({ state: 'incompatible' });
  });

  it('accepts a newer MINOR and keeps the SDK version as the negotiated one', async () => {
    seedFiles();
    const { deps } = scripted(versionAnswer({ queueProtocol: { version: '1.4.0', accepts: '^1.0.0' } }));
    expect(await createDaemonResolver(dir, deps).resolve()).toMatchObject({ state: 'ready', daemon: { negotiated: PROTOCOL_VERSION, protocol: { version: '1.4.0' } } });
  });

  it('caches by (port, pid): a second resolve sends no request', async () => {
    seedFiles();
    const { deps, calls } = scripted(versionAnswer());
    const resolver = createDaemonResolver(dir, deps);
    await resolver.resolve();
    await resolver.resolve();
    expect(calls).toHaveLength(1);
  });

  it('re-verifies when the port file changes', async () => {
    seedFiles();
    const { deps, calls } = scripted(versionAnswer());
    const resolver = createDaemonResolver(dir, deps);
    await resolver.resolve();
    seedFiles(4242, 47911);
    await resolver.resolve();
    expect(calls).toHaveLength(2);
  });

  it('re-verifies after invalidate()', async () => {
    seedFiles();
    const { deps, calls } = scripted(versionAnswer());
    const resolver = createDaemonResolver(dir, deps);
    await resolver.resolve();
    resolver.invalidate();
    await resolver.resolve();
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failed verification', async () => {
    seedFiles();
    const { deps, calls } = scripted({ kind: 'failure', message: 'x', connected: false, timedOut: false }, false);
    const resolver = createDaemonResolver(dir, deps);
    await resolver.resolve();
    await resolver.resolve();
    expect(calls).toHaveLength(2);
  });

  it('reads the token only after a successful verification', async () => {
    seedFiles();
    const resolver = createDaemonResolver(dir, scripted(versionAnswer()).deps);
    expect(resolver.token()).toEqual({ ok: false, reason: expect.stringContaining('verified') });
    await resolver.resolve();
    expect(resolver.token()).toEqual({ ok: true, token: 'tok' });
  });

  it('caches the token and re-reads it on refresh', async () => {
    seedFiles();
    const resolver = createDaemonResolver(dir, scripted(versionAnswer()).deps);
    await resolver.resolve();
    expect(resolver.token()).toEqual({ ok: true, token: 'tok' });
    writeFileSync(join(dir, 'health_token'), 'rotated');
    expect(resolver.token()).toEqual({ ok: true, token: 'tok' });
    expect(resolver.token({ refresh: true })).toEqual({ ok: true, token: 'rotated' });
    expect(resolver.token()).toEqual({ ok: true, token: 'rotated' });
  });

  it('forgets the token when invalidated', async () => {
    seedFiles();
    const resolver = createDaemonResolver(dir, scripted(versionAnswer()).deps);
    await resolver.resolve();
    resolver.invalidate();
    expect(resolver.token().ok).toBe(false);
  });
});

describe('createDaemonResolver with the default HTTP and pid probes', () => {
  let fake: FakeDaemon | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('verifies a real local daemon', async () => {
    fake = await startFakeDaemon({ configDir: dir, queueProtocol: { version: '1.0.0', accepts: '^1.0.0' } });
    fake.writeFiles();
    expect(await createDaemonResolver(dir).resolve()).toMatchObject({ state: 'ready', daemon: { port: fake.port, pid: process.pid } });
  });

  it('is stopped when the port file points to a closed port and the pid is dead', async () => {
    writePortFile(JSON.stringify({ sdkVersion: 1, port: await closedPort(), pid: 2147483000 }));
    expect(await createDaemonResolver(dir).resolve()).toMatchObject({ state: 'stopped', cause: 'process-gone' });
  });
});
