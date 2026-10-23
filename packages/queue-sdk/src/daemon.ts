import { getErrorMessage } from './errors.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loopbackRequest, type HttpOutcome, type LoopbackRequest } from './http.js';
import { negotiate, parseDaemonProtocol, type QueueProtocolInfo } from './protocol.js';

export interface PortFile {
  port: number;
  pid: number;
}

export type Located =
  | { state: 'absent'; path: string }
  | { state: 'corrupt'; path: string; reason: string }
  | { state: 'found'; path: string; file: PortFile };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Reads `<configDir>/config.port` strictly: a file that exists but is not what the daemon writes is reported, not guessed at. */
export function locateDaemon(configDir: string): Located {
  const path = join(configDir, 'config.port');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return { state: 'absent', path };
    }
    return { state: 'corrupt', path, reason: `cannot read ${path}: ${getErrorMessage(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { state: 'corrupt', path, reason: `${path} is not valid JSON (${getErrorMessage(error)}): delete it or run \`queue start\`` };
  }
  const port = isRecord(parsed) ? parsed['port'] : undefined;
  const pid = isRecord(parsed) ? parsed['pid'] : undefined;
  if (!isRecord(parsed) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535 || !Number.isInteger(pid) || (pid as number) < 1) {
    return { state: 'corrupt', path, reason: `${path} does not hold { port, pid } with a valid port and pid (found ${JSON.stringify(parsed)}): delete it or run \`queue start\`` };
  }
  return { state: 'found', path, file: { port: port as number, pid: pid as number } };
}

export type TokenResult = { ok: true; token: string } | { ok: false; reason: string };

/** Reads `<configDir>/health_token`. */
export function readToken(configDir: string): TokenResult {
  const path = join(configDir, 'health_token');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const hint = 'the daemon creates it on its first start; if your queue uses another config dir, set QUEUE_CONFIG_DIR or the configDir option';
    return { ok: false, reason: isMissing(error) ? `no health_token at ${path}: ${hint}` : `cannot read ${path} (${getErrorMessage(error)}): ${hint}` };
  }
  const token = text.trim();
  if (token === '') {
    return { ok: false, reason: `${path} is empty: run \`queue start\` or delete the file so the daemon creates a new token` };
  }
  return { ok: true, token };
}

function normalise(path: string, platform: NodeJS.Platform): string {
  const full = resolve(path).replace(/[\\/]+$/, '');
  return platform === 'win32' ? full.toLowerCase() : full;
}

/** Same directory, ignoring trailing separators, relative segments and (on win32) letter case. */
export function sameDirectory(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalise(a, platform) === normalise(b, platform);
}

export interface DaemonDeps {
  request: (options: LoopbackRequest) => Promise<HttpOutcome>;
  isPidAlive: (pid: number) => boolean;
  platform: NodeJS.Platform;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const DEFAULT_DEPS: DaemonDeps = { request: loopbackRequest, isPidAlive, platform: process.platform };

export interface DaemonInfo {
  port: number;
  pid: number;
  /** The daemon package version, informational. */
  version: string;
  /** The push protocol the daemon implements and the client range it accepts. */
  protocol: QueueProtocolInfo;
  /** The protocol version to put in the push body. */
  negotiated: string;
}

export type StoppedCause = 'no-port-file' | 'corrupt-port-file' | 'process-gone' | 'not-answering' | 'stale-port-file';

export type Resolution =
  | { state: 'ready'; daemon: DaemonInfo }
  | { state: 'stopped'; cause: StoppedCause; reason: string }
  | { state: 'incompatible'; reason: string };

export interface DaemonResolver {
  /** Finds and verifies the daemon. The verified (port, pid) is cached until the port file changes or `invalidate()`. */
  resolve(): Promise<Resolution>;
  /** Forgets the verified daemon and its token: call after a connection error or a 401. */
  invalidate(): void;
  /** The token of the verified daemon; `refresh` re-reads the file. Never available before verification succeeded. */
  token(options?: { refresh?: boolean }): TokenResult;
}

const VERSION_TIMEOUT_MS = 2000;

export function createDaemonResolver(configDir: string, deps: DaemonDeps = DEFAULT_DEPS): DaemonResolver {
  let cached: { key: string; daemon: DaemonInfo } | undefined;
  let cachedToken: { key: string; token: string } | undefined;

  async function verify(file: PortFile): Promise<Resolution> {
    const outcome = await deps.request({ port: file.port, method: 'GET', path: '/version', timeoutMs: VERSION_TIMEOUT_MS });
    if (outcome.kind === 'failure') {
      const alive = deps.isPidAlive(file.pid);
      return alive
        ? { state: 'stopped', cause: 'not-answering', reason: `the daemon (pid ${file.pid}) is running but port ${file.port} does not answer GET /version: ${outcome.message}` }
        : { state: 'stopped', cause: 'process-gone', reason: `the daemon (pid ${file.pid}) is not running and port ${file.port} does not answer: stale ${join(configDir, 'config.port')}` };
    }
    const stale = (detail: string): Resolution => ({ state: 'stopped', cause: 'stale-port-file', reason: `${join(configDir, 'config.port')} is stale: ${detail}` });
    let body: unknown;
    try {
      body = outcome.status === 200 ? JSON.parse(outcome.text) : undefined;
    } catch {
      body = undefined;
    }
    if (!isRecord(body) || typeof body['pid'] !== 'number') {
      return stale(`port ${file.port} is used by another program (GET /version answered HTTP ${outcome.status} without a pid)`);
    }
    if (body['pid'] !== file.pid) {
      return stale(`port ${file.port} answers with pid ${body['pid']} but the file records pid ${file.pid}`);
    }
    if (typeof body['config_dir'] !== 'string' || !sameDirectory(body['config_dir'], configDir, deps.platform)) {
      return stale(`the daemon on port ${file.port} uses config dir ${JSON.stringify(body['config_dir'])}, not ${configDir}`);
    }
    let protocol: QueueProtocolInfo;
    try {
      protocol = parseDaemonProtocol(body);
    } catch (error) {
      return { state: 'incompatible', reason: getErrorMessage(error) };
    }
    const negotiation = negotiate(protocol);
    if (!negotiation.ok) {
      return { state: 'incompatible', reason: negotiation.reason };
    }
    const version = typeof body['version'] === 'string' ? body['version'] : 'unknown';
    return { state: 'ready', daemon: { port: file.port, pid: file.pid, version, protocol, negotiated: negotiation.version } };
  }

  return {
    async resolve(): Promise<Resolution> {
      const located = locateDaemon(configDir);
      if (located.state !== 'found') {
        cached = undefined;
        cachedToken = undefined;
        return located.state === 'absent'
          ? { state: 'stopped', cause: 'no-port-file', reason: `no ${located.path}: the daemon is not running` }
          : { state: 'stopped', cause: 'corrupt-port-file', reason: located.reason };
      }
      const key = `${located.file.port}:${located.file.pid}`;
      if (cached?.key === key) {
        return { state: 'ready', daemon: cached.daemon };
      }
      cached = undefined;
      cachedToken = undefined;
      const result = await verify(located.file);
      if (result.state === 'ready') {
        cached = { key, daemon: result.daemon };
      }
      return result;
    },
    invalidate(): void {
      cached = undefined;
      cachedToken = undefined;
    },
    token(options: { refresh?: boolean } = {}): TokenResult {
      if (cached === undefined) {
        return { ok: false, reason: 'the daemon has not been verified yet, the token is not read before that' };
      }
      if (cachedToken?.key === cached.key && options.refresh !== true) {
        return { ok: true, token: cachedToken.token };
      }
      const read = readToken(configDir);
      if (read.ok) {
        cachedToken = { key: cached.key, token: read.token };
      }
      return read;
    },
  };
}
