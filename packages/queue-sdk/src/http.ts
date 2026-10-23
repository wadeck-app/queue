import { getErrorMessage } from './errors.js';
import { request } from 'node:http';

export interface LoopbackRequest {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Total time for the whole exchange, in ms. */
  timeoutMs: number;
  /** Largest response body read, in bytes (default 1 MiB). */
  maxBytes?: number;
}

export type HttpOutcome =
  | { kind: 'response'; status: number; text: string }
  | {
      kind: 'failure';
      message: string;
      /** Node error code such as ECONNREFUSED, when there is one. */
      code?: string;
      /** True once the TCP connection was established: the daemon may have received the request. */
      connected: boolean;
      timedOut: boolean;
    };

const DEFAULT_MAX_BYTES = 1024 * 1024;

/** One HTTP exchange with the daemon on 127.0.0.1. Never rejects: every problem is an `HttpOutcome` of kind `failure`. */
export function loopbackRequest(options: LoopbackRequest): Promise<HttpOutcome> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    let connected = false;
    let timedOut = false;
    let settled = false;
    const settle = (outcome: HttpOutcome): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };
    const fail = (message: string, code?: string): void => {
      settle({ kind: 'failure', message, ...(code !== undefined && { code }), connected, timedOut });
    };
    const headers = { ...options.headers, ...(options.body !== undefined && { 'Content-Length': String(Buffer.byteLength(options.body)) }) };
    const req = request({ host: '127.0.0.1', port: options.port, method: options.method, path: options.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(`the response is larger than ${maxBytes} bytes`);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => settle({ kind: 'response', status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => fail(getErrorMessage(error), (error as NodeJS.ErrnoException).code));
      res.on('aborted', () => fail('the connection was closed before the response was complete'));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      fail(`no answer within ${options.timeoutMs} ms`);
      req.destroy();
    }, options.timeoutMs);
    req.on('socket', (socket) => {
      if (!socket.connecting) {
        connected = true;
      }
      socket.on('connect', () => {
        connected = true;
      });
    });
    req.on('error', (error) => fail(getErrorMessage(error), (error as NodeJS.ErrnoException).code));
    req.end(options.body);
  });
}
