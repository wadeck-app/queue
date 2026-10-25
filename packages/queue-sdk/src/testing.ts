import { join } from 'node:path';
import { DAEMON_ACCEPTS, daemonSupportsEventCatalog, PROTOCOL_VERSION } from './protocol.js';
import { makeTempDir, removeDir, startFakeDaemon } from './testing/fakeDaemon.js';

// Test helper for the programs that adopt the SDK (import from '@wadeck-app/queue-sdk/testing'): a throwaway daemon on a free
// port in a temporary config dir. The real SDK runs its real path against it (version check, token, push, register-events),
// without touching the real daemon, its port, or its registration with app-core.

export interface RecordedPush {
  event: string;
  payload: unknown;
  /** Absolute project directory the SDK sent. */
  cwd: string;
  /** The push protocol version the SDK spoke. */
  protocol?: string;
  /** Request timeout of a before* event, when one was given. */
  timeout?: number;
  /** The project id the SDK sent (push protocol 1.2.0), when it sent one. */
  project?: string;
}

export interface RecordedRegistration {
  source: string;
  /** The events exactly as the SDK sent them. The fake applies none of the daemon's rules to them. */
  events: unknown[];
  /** The push protocol version the SDK spoke. */
  protocol?: string;
}

export interface FakeQueueDaemonOptions {
  /**
   * The push protocol version the fake daemon advertises in GET /version. Default: the version of this SDK. Below `1.1.0` it behaves
   * like a daemon without the event catalog: `registerEvents` answers `unsupported`, and a client that sends `register-events`
   * anyway gets HTTP 404 `Unknown command`.
   */
  protocolVersion?: string;
}

export interface FakeQueueDaemon {
  /** Pass it as the `configDir` option of createQueuePublisher (or set QUEUE_CONFIG_DIR to it). */
  configDir: string;
  /** What was pushed so far, in order. */
  pushes(): RecordedPush[];
  /** The declarations received so far, in order (empty for a daemon below protocol 1.1.0). Nothing is stored or validated. */
  registrations(): RecordedRegistration[];
  /** The next push gets this result instead of `queued` / `dispatched`, e.g. `{ status: 'aborted', reason: '...' }`. */
  respondNext(result: Record<string, unknown>): void;
  /** The next registration gets this result instead of `registered`, e.g. `{ status: 'rejected', reason: '...', problems: [...] }`. */
  respondNextRegistration(result: Record<string, unknown>): void;
  /** The connection is broken on the next push: the SDK answers `unknown`. */
  resetNext(): void;
  /**
   * The connection is broken on the next `times` registrations (default 1). The SDK retries a registration once, because it is
   * idempotent: one break still ends `registered`, two in a row end `unknown`.
   */
  resetNextRegistration(times?: number): void;
  /** Stops the daemon and removes its temporary config dir. */
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function startFakeQueueDaemon(options: FakeQueueDaemonOptions = {}): Promise<FakeQueueDaemon> {
  const version = options.protocolVersion ?? PROTOCOL_VERSION;
  const supportsCatalog = daemonSupportsEventCatalog(version);
  const dir = makeTempDir('queue-sdk-fake-daemon-');
  const fake = await startFakeDaemon({
    configDir: join(dir, 'queue-config'),
    queueProtocol: { version, accepts: DAEMON_ACCEPTS },
    supportsRegisterEvents: supportsCatalog,
  });
  fake.writeFiles();
  return {
    configDir: fake.configDir,
    pushes: () =>
      fake.pushes().map((request): RecordedPush => {
        const body: unknown = JSON.parse(request.body);
        if (!isRecord(body) || typeof body['event'] !== 'string' || typeof body['cwd'] !== 'string') {
          throw new Error(`the SDK sent a push body that is not { event, payload, cwd }: ${request.body.slice(0, 200)}`);
        }
        return {
          event: body['event'],
          payload: body['payload'],
          cwd: body['cwd'],
          ...(typeof body['protocol'] === 'string' && { protocol: body['protocol'] }),
          ...(typeof body['timeout'] === 'number' && { timeout: body['timeout'] }),
          ...(typeof body['project'] === 'string' && { project: body['project'] }),
        };
      }),
    registrations: () =>
      supportsCatalog
        ? fake.registrations().map((request): RecordedRegistration => {
            const body: unknown = JSON.parse(request.body);
            if (!isRecord(body) || typeof body['source'] !== 'string' || !Array.isArray(body['events'])) {
              throw new Error(`the SDK sent a register-events body that is not { source, events }: ${request.body.slice(0, 200)}`);
            }
            return { source: body['source'], events: body['events'], ...(typeof body['protocol'] === 'string' && { protocol: body['protocol'] }) };
          })
        : [],
    respondNext: (result) => {
      fake.script.push({ kind: 'answer', result });
    },
    respondNextRegistration: (result) => {
      fake.registerScript.push({ kind: 'answer', result });
    },
    resetNext: () => {
      fake.script.push({ kind: 'reset' });
    },
    resetNextRegistration: (times = 1) => {
      for (let i = 0; i < times; i++) {
        fake.registerScript.push({ kind: 'reset' });
      }
    },
    close: async () => {
      await fake.close();
      removeDir(dir);
    },
  };
}
