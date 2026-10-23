import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real HTTP server on 127.0.0.1 that behaves like the queue daemon for the parts the SDK talks to (GET /version, POST /push),
// plus switches to simulate each failure. Test helper only: excluded from the build.

export type PushStep =
  | { kind: 'reset' }
  | { kind: 'delay'; ms: number }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'answer'; result: Record<string, unknown> };

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  authorized: boolean;
  body: string;
}

export interface FakeDaemonOptions {
  /** Directory holding config.port and health_token; created when missing. */
  configDir: string;
  /** Pid reported by GET /version (default: this process, which is alive). */
  reportedPid?: number;
  /** config_dir reported by GET /version (default: configDir). */
  reportedConfigDir?: string;
  /** `queueProtocol` of GET /version; undefined = the field is absent (legacy daemon). */
  queueProtocol?: { version: string; accepts: string };
  /** Token the daemon accepts, also written to health_token. */
  token?: string;
}

export interface FakeDaemon {
  port: number;
  token: string;
  configDir: string;
  requests: RecordedRequest[];
  /** Consumed one per authorized push, in order; an empty script means a normal answer. */
  script: PushStep[];
  /** Changes the token the daemon accepts without touching health_token. */
  acceptedToken: string;
  /** Called each time a push is answered 401, e.g. to rotate health_token like a restarted daemon would. */
  onUnauthorized?: () => void;
  /** Writes config.port (pid = this process unless overridden) and health_token. */
  writeFiles(overrides?: { pid?: number; port?: number }): void;
  pushes(): RecordedRequest[];
  close(): Promise<void>;
}

export const DEFAULT_TOKEN = 'a'.repeat(32);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function defaultAnswer(body: string, counter: number): Record<string, unknown> {
  let event = '';
  try {
    event = String((JSON.parse(body) as { event?: unknown }).event);
  } catch {
    event = '';
  }
  return event.startsWith('before') ? { status: 'dispatched', eventId: `evt-${counter}`, result: { fine: true } } : { status: 'queued', eventId: `evt-${counter}` };
}

export async function startFakeDaemon(options: FakeDaemonOptions): Promise<FakeDaemon> {
  mkdirSync(options.configDir, { recursive: true });
  const requests: RecordedRequest[] = [];
  const script: PushStep[] = [];
  let counter = 0;
  const daemon = {
    port: 0,
    token: options.token ?? DEFAULT_TOKEN,
    configDir: options.configDir,
    requests,
    script,
    acceptedToken: options.token ?? DEFAULT_TOKEN,
  } as FakeDaemon;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const authorization = req.headers['authorization'];
      const authorized = authorization === `Bearer ${daemon.acceptedToken}`;
      requests.push({ method: req.method ?? '', url: req.url ?? '', authorization, authorized, body });
      if (req.method === 'GET' && req.url === '/version') {
        sendJson(res, 200, {
          version: '9.9.9',
          pid: options.reportedPid ?? process.pid,
          config_dir: options.reportedConfigDir ?? options.configDir,
          sdkVersion: 1,
          port: daemon.port,
          ...(options.queueProtocol !== undefined && { queueProtocol: options.queueProtocol }),
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/push') {
        if (!authorized) {
          daemon.onUnauthorized?.();
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        counter += 1;
        const step = script.shift();
        if (step?.kind === 'reset') {
          req.socket.destroy();
          return;
        }
        if (step?.kind === 'http') {
          res.statusCode = step.status;
          res.end(step.body);
          return;
        }
        if (step?.kind === 'delay') {
          await new Promise((resolve) => setTimeout(resolve, step.ms));
        }
        sendJson(res, 200, { ok: true, result: step?.kind === 'answer' ? step.result : defaultAnswer(body, counter) });
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  daemon.port = (server.address() as AddressInfo).port;
  daemon.writeFiles = (overrides = {}): void => {
    writeFileSync(join(options.configDir, 'config.port'), JSON.stringify({ sdkVersion: 1, port: overrides.port ?? daemon.port, pid: overrides.pid ?? process.pid, startedAt: new Date().toISOString() }));
    writeFileSync(join(options.configDir, 'health_token'), `${daemon.token}\n`);
  };
  daemon.pushes = () => requests.filter((request) => request.method === 'POST' && request.url === '/push');
  daemon.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return daemon;
}

/** A fresh empty temp directory; the caller removes it with `removeDir`. */
export function makeTempDir(prefix = 'queue-sdk-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** A TCP port nothing listens on any more. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
