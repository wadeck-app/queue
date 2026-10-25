import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { readDaemonVersion, versionMismatchWarning } from './daemonVersion.js';

const OLD = '2026.10.24-198-aaaaaaaa';
const NEW = '2026.10.25-217-bbbbbbbb';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A daemon that answers GET /version with this version, and the config dir whose port file points at it. */
async function fakeDaemon(version: string | undefined): Promise<string> {
  const configDir = mkdtempSync(join(tmpdir(), 'queue-daemon-version-'));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const server: Server = createServer((req, res) => {
    if (req.url === '/version' && version !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version, pid: 1 }));
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  writeFileSync(join(configDir, 'config.port'), JSON.stringify({ sdkVersion: 1, port: (server.address() as AddressInfo).port, pid: 1, startedAt: new Date().toISOString() }));
  return configDir;
}

describe('readDaemonVersion', () => {
  it('reads the version the running daemon reports', async () => {
    expect(await readDaemonVersion(await fakeDaemon(OLD))).toBe(OLD);
  });

  it('is undefined without a port file, instead of throwing', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'queue-daemon-version-'));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    expect(await readDaemonVersion(configDir)).toBeUndefined();
  });

  it('is undefined when the daemon does not answer /version', async () => {
    expect(await readDaemonVersion(await fakeDaemon(undefined))).toBeUndefined();
  });
});

describe('versionMismatchWarning', () => {
  it('says nothing when the daemon runs the code of this CLI', () => {
    expect(versionMismatchWarning(NEW, NEW)).toBeUndefined();
  });

  it('warns when a release daemon is older than this release CLI: it keeps the old code until it is restarted; the fix is given, and the pending events are said to be kept', () => {
    const warning = versionMismatchWarning(OLD, NEW)!;
    expect(warning).toContain(OLD);
    expect(warning).toContain(NEW);
    expect(warning).toContain('queue stop');
    expect(warning).toContain('WAL');
  });

  it('says nothing when the daemon version is unknown (nothing to compare)', () => {
    expect(versionMismatchWarning(undefined, NEW)).toBeUndefined();
  });

  it('says nothing for a dev build on either side: its version is never the daemon\'s', () => {
    expect(versionMismatchWarning(OLD, '0.0.0-dev')).toBeUndefined();
    expect(versionMismatchWarning('0.0.0-dev', NEW)).toBeUndefined();
  });
});
