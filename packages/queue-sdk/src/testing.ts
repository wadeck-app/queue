import { join } from 'node:path';
import { DAEMON_ACCEPTS, PROTOCOL_VERSION } from './protocol.js';
import { makeTempDir, removeDir, startFakeDaemon } from './testing/fakeDaemon.js';

// Test helper for the programs that adopt the SDK (import from '@wadeck-app/queue-sdk/testing'): a throwaway daemon on a free
// port in a temporary config dir. The real SDK runs its real path against it (version check, token, push), without touching the
// real daemon, its port, or its registration with app-core.

export interface RecordedPush {
  event: string;
  payload: unknown;
  /** Absolute project directory the SDK sent. */
  cwd: string;
  /** The push protocol version the SDK spoke. */
  protocol?: string;
  /** Request timeout of a before* event, when one was given. */
  timeout?: number;
}

export interface FakeQueueDaemon {
  /** Pass it as the `configDir` option of createQueuePublisher (or set QUEUE_CONFIG_DIR to it). */
  configDir: string;
  /** What was pushed so far, in order. */
  pushes(): RecordedPush[];
  /** The next push gets this result instead of `queued` / `dispatched`, e.g. `{ status: 'aborted', reason: '...' }`. */
  respondNext(result: Record<string, unknown>): void;
  /** The connection is broken on the next push: the SDK answers `unknown`. */
  resetNext(): void;
  /** Stops the daemon and removes its temporary config dir. */
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function startFakeQueueDaemon(): Promise<FakeQueueDaemon> {
  const dir = makeTempDir('queue-sdk-fake-daemon-');
  const fake = await startFakeDaemon({ configDir: join(dir, 'queue-config'), queueProtocol: { version: PROTOCOL_VERSION, accepts: DAEMON_ACCEPTS } });
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
        };
      }),
    respondNext: (result) => {
      fake.script.push({ kind: 'answer', result });
    },
    resetNext: () => {
      fake.script.push({ kind: 'reset' });
    },
    close: async () => {
      await fake.close();
      removeDir(dir);
    },
  };
}
