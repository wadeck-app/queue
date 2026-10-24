import { getErrorMessage } from './errors.js';
import { resolve } from 'node:path';
import { createDaemonResolver, isPidAlive, type DaemonInfo, type Resolution } from './daemon.js';
import { loopbackRequest, type HttpOutcome, type LoopbackRequest } from './http.js';
import { resolveConfigDir } from './configDir.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { createReporter, describeHttpError, type FailureKind, type QueueFailure, type Reporter } from './report.js';
import { defaultStartDeps, startDaemon, type RunOutcome, type StartDeps, type StartResult } from './start.js';
import { parsePushAnswer, serializePushRequest, toPublishResult, type PublishResult, type PushRequest, type PushResponse } from './wire.js';

export interface QueuePublisherOptions {
  /** Project directory sent with every event (selects `.queue/subscribers.yml`). Default `process.cwd()`. */
  cwd?: string;
  /** Queue config dir. Default: QUEUE_CONFIG_DIR, else $XDG_CONFIG_HOME/queue, else ~/.config/queue. */
  configDir?: string;
  /** HTTP timeout in ms of a fire-and-forget push. Default 5000. */
  timeoutMs?: number;
  /** Largest number of pushes in flight; the overflow is dropped and reported. Default 100. */
  maxPending?: number;
  /** True: nothing is printed by default (`onError` is still called). */
  silent?: boolean;
  /**
   * True: nothing is sent, started or reported; every call answers `dropped` saying so. FOR AUTOMATED TESTS ONLY: it must not appear
   * outside test files. To try a program in development without a queue, set the environment variable QUEUE_SDK_OFF=1 instead.
   */
  off?: boolean;
  /** Receives every failure. */
  onError?: (failure: QueueFailure) => void;
  /** Receives the notices of the daemon (e.g. a deprecated protocol), each once. */
  onWarning?: (warning: string) => void;
}

export interface PublishOptions {
  /** Overrides the publisher's `cwd` for this event. */
  cwd?: string;
  /** Overrides the HTTP timeout. For `before*` events it is the request timeout sent to the daemon and 5000 ms more are waited. */
  timeoutMs?: number;
}

export interface QueueStatus {
  available: boolean;
  /** `daemon`: running and verified. `queue-start`: stopped, but `queue start` is on PATH and will be run on the first event. */
  via?: 'daemon' | 'queue-start';
  daemonVersion?: string;
  /** The push protocol version that would be spoken. */
  protocol?: string;
  reason?: string;
}

export interface QueuePublisher {
  /** Fire and forget. Never throws. Callers that exit the process call `await flush()` first. */
  publish(event: string, payload: unknown, options?: PublishOptions): void;
  /** Never rejects: failures are in the result. `unknown` means the event may have been queued. */
  publishAndWait(event: string, payload: unknown, options?: PublishOptions): Promise<PublishResult>;
  /** Resolves when every push in flight has settled. */
  flush(): Promise<void>;
  /** Describes how the daemon would be reached. Sends no event and starts nothing. */
  status(): Promise<QueueStatus>;
}

/** Test seams: everything the publisher takes from the outside world. */
export interface PublisherDeps {
  request?: (options: LoopbackRequest) => Promise<HttpOutcome>;
  isPidAlive?: (pid: number) => boolean;
  find?: () => string | undefined;
  run?: (executable: string, configDir: string) => Promise<RunOutcome>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sink?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PENDING = 100;
// Daemon-side default of the request timeout of a before* event, and the margin the client adds on top.
const DAEMON_BEFORE_TIMEOUT_MS = 30000;
const BEFORE_MARGIN_MS = 5000;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}


const OFF_VARIABLE = 'QUEUE_SDK_OFF';

/** QUEUE_SDK_OFF=1 switches the SDK off for a development run. Unset, empty or 0: active. Any other value is a mistake: reported, and the SDK stays ACTIVE so a typo cannot lose events. */
function readOffVariable(env: NodeJS.ProcessEnv, reporter: Reporter): boolean {
  const value = env[OFF_VARIABLE];
  if (value === undefined || value === '' || value === '0') {
    return false;
  }
  if (value === '1') {
    reporter.notice(`the environment variable ${OFF_VARIABLE}=1 is set: no event is sent. It is a switch for development and tests; unset it wherever events must reach the queue.`);
    return true;
  }
  reporter.failure({
    kind: 'invalid-argument',
    event: '(createQueuePublisher)',
    outcome: 'dropped',
    message: `the environment variable ${OFF_VARIABLE} must be "1" (switch the SDK off) or "0" or unset, got ${JSON.stringify(value)}: ignored, events are sent`,
  });
  return false;
}

type Ensured = { ok: true; daemon: DaemonInfo; token: string } | { ok: false; kind: FailureKind; message: string };

export function createQueuePublisher(options: QueuePublisherOptions = {}): QueuePublisher {
  return createQueuePublisherWithDeps(options, {});
}

/** Same as `createQueuePublisher` with the outside world injected. Not part of the public API. */
export function createQueuePublisherWithDeps(options: QueuePublisherOptions, deps: PublisherDeps): QueuePublisher {
  const reporter = createReporter({ silent: options.silent, onError: options.onError, onWarning: options.onWarning, sink: deps.sink });
  const configDir = options.configDir ?? resolveConfigDir(deps.env ?? process.env);
  const defaultCwd = options.cwd ?? process.cwd();
  const request = deps.request ?? loopbackRequest;
  const configProblem = (name: string, value: unknown, fallback: number): number => {
    if (value === undefined) {
      return fallback;
    }
    if (isPositiveNumber(value)) {
      return value;
    }
    reporter.failure({ kind: 'invalid-argument', event: '(createQueuePublisher)', outcome: 'dropped', message: `option ${name} must be a positive number, got ${String(value)}: using ${fallback}` });
    return fallback;
  };
  const timeoutMs = configProblem('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxPending = configProblem('maxPending', options.maxPending, DEFAULT_MAX_PENDING);

  const resolver = createDaemonResolver(configDir, {
    request,
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    platform: deps.platform ?? process.platform,
  });

  let resolving: Promise<Resolution> | undefined;
  function resolveShared(): Promise<Resolution> {
    if (resolving === undefined) {
      const current: Promise<Resolution> = resolver.resolve().finally(() => {
        if (resolving === current) {
          resolving = undefined;
        }
      });
      resolving = current;
    }
    return resolving;
  }

  const startDeps: StartDeps = {
    ...defaultStartDeps(async () => (await resolveShared()).state === 'ready', deps.env ?? process.env),
    ...(deps.find !== undefined && { find: deps.find }),
    ...(deps.run !== undefined && { run: deps.run }),
    ...(deps.sleep !== undefined && { sleep: deps.sleep }),
    ...(deps.pollIntervalMs !== undefined && { pollIntervalMs: deps.pollIntervalMs }),
    ...(deps.startTimeoutMs !== undefined && { timeoutMs: deps.startTimeoutMs }),
  };

  // Single flight: concurrent publishes while the daemon is stopped share one `queue start`.
  let starting: Promise<StartResult> | undefined;
  function startShared(): Promise<StartResult> {
    if (starting === undefined) {
      const current: Promise<StartResult> = (async (): Promise<StartResult> => {
        // A start that finished while this caller was still looking at the old state must not be run a second time.
        if ((await resolveShared()).state === 'ready') {
          return { ok: true };
        }
        return startDaemon(configDir, startDeps);
      })().finally(() => {
        if (starting === current) {
          starting = undefined;
        }
      });
      starting = current;
    }
    return starting;
  }

  async function ensureDaemon(): Promise<Ensured> {
    let state = await resolveShared();
    if (state.state === 'stopped') {
      const was = state;
      const started = await startShared();
      if (!started.ok) {
        const corrupt = was.cause === 'corrupt-port-file';
        return { ok: false, kind: corrupt ? 'corrupt-port-file' : started.kind, message: corrupt ? `${was.reason}; ${started.reason}` : started.reason };
      }
      state = await resolveShared();
      if (state.state === 'stopped') {
        return { ok: false, kind: 'not-ready', message: `the daemon was started but is not usable: ${state.reason}` };
      }
    }
    if (state.state === 'incompatible') {
      return { ok: false, kind: 'incompatible', message: state.reason };
    }
    const token = resolver.token();
    if (!token.ok) {
      return { ok: false, kind: 'no-token', message: token.reason };
    }
    return { ok: true, daemon: state.daemon, token: token.token };
  }

  async function attempt(event: string, payload: unknown, call: PublishOptions): Promise<PublishResult> {
    const fail = (kind: FailureKind, message: string, outcome: 'dropped' | 'unknown' = 'dropped'): PublishResult => {
      reporter.failure({ kind, message, event, outcome });
      return { status: outcome === 'unknown' ? 'unknown' : 'dropped', reason: message };
    };
    if (typeof event !== 'string' || event.trim() === '') {
      return fail('invalid-argument', `the event name must be a non-empty string such as "myapp.thing_done", got ${JSON.stringify(event) ?? String(event)}`);
    }
    if (call.timeoutMs !== undefined && !isPositiveNumber(call.timeoutMs)) {
      return fail('invalid-argument', `timeoutMs must be a positive number of milliseconds, got ${String(call.timeoutMs)}`);
    }
    const isBefore = event.startsWith('before');
    const requestTimeout = isBefore ? call.timeoutMs : undefined;
    const httpTimeout = isBefore ? (requestTimeout ?? DAEMON_BEFORE_TIMEOUT_MS) + BEFORE_MARGIN_MS : (call.timeoutMs ?? timeoutMs);
    const wire: PushRequest = { event, payload, cwd: resolve(call.cwd ?? defaultCwd), protocol: PROTOCOL_VERSION, ...(requestTimeout !== undefined && { timeout: requestTimeout }) };
    const serialized = serializePushRequest(wire);
    if (!serialized.ok) {
      return fail('not-serialisable', serialized.reason);
    }

    let authRetried = false;
    let restartRetried = false;
    for (;;) {
      const ensured = await ensureDaemon();
      if (!ensured.ok) {
        return fail(ensured.kind, ensured.message);
      }
      const { daemon, token } = ensured;
      let body = serialized.body;
      if (daemon.negotiated !== PROTOCOL_VERSION) {
        const again = serializePushRequest({ ...wire, protocol: daemon.negotiated });
        body = again.ok ? again.body : body;
      }
      const outcome = await request({
        port: daemon.port,
        method: 'POST',
        path: '/push',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        timeoutMs: httpTimeout,
      });
      if (outcome.kind === 'failure') {
        resolver.invalidate();
        if (!outcome.connected && outcome.code === 'ECONNREFUSED') {
          if (!restartRetried) {
            restartRetried = true;
            continue;
          }
          return fail('not-ready', `the daemon refused the connection on port ${daemon.port} again after being started: run \`queue status\` in a terminal`);
        }
        if (!outcome.connected) {
          return fail('unexpected', `could not reach the daemon on port ${daemon.port}: ${outcome.message}`);
        }
        const cause = outcome.timedOut ? `no answer within ${httpTimeout} ms` : `the connection broke while the daemon was handling the event (${outcome.message})`;
        return fail('unknown-outcome', `${cause}: the event may have been queued, it is not retried (raise timeoutMs if the daemon is slow)`, 'unknown');
      }
      if (outcome.status === 401) {
        resolver.invalidate();
        if (!authRetried) {
          authRetried = true;
          continue;
        }
        return fail('unauthorized', describeHttpError(401, outcome.text, [token]));
      }
      if (outcome.status !== 200) {
        return fail('http-error', describeHttpError(outcome.status, outcome.text, [token]));
      }
      return interpret(daemon, outcome.text, fail);
    }
  }

  function interpret(daemon: DaemonInfo, text: string, fail: (kind: FailureKind, message: string) => PublishResult): PublishResult {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return fail('bad-answer', `the daemon answered something that is not JSON (${getErrorMessage(error)}): ${text.slice(0, 200)}`);
    }
    const parsed = parsePushAnswer(json);
    if (!parsed.ok) {
      return fail('bad-answer', parsed.reason);
    }
    const response: PushResponse = parsed.response;
    reporter.warnings(response.warnings ?? []);
    if (response.status === 'aborted') {
      return fail('aborted', `the daemon aborted the event: ${response.reason ?? 'a before* subscriber refused it'}`);
    }
    if (response.status === 'rejected') {
      const accepted = response.supported ?? daemon.protocol.accepts;
      return fail(
        'rejected',
        `the daemon rejected the event${response.reason !== undefined ? ` (${response.reason})` : ''}: this SDK speaks push protocol ${PROTOCOL_VERSION}, the daemon (protocol ${daemon.protocol.version}) accepts ${accepted}: update @wadeck-app/queue-sdk or queue-cli so that the versions overlap`,
      );
    }
    reporter.success();
    return toPublishResult(response);
  }

  const pending = new Set<Promise<PublishResult>>();

  const envOff = readOffVariable(deps.env ?? process.env, reporter);
  const isOff = options.off === true || envOff;
  const OFF_REASON = options.off === true ? 'the publisher is switched off (option off: true)' : 'the publisher is switched off by the environment variable QUEUE_SDK_OFF=1';

  function launch(event: string, payload: unknown, call: PublishOptions): Promise<PublishResult> {
    if (isOff) {
      return Promise.resolve({ status: 'dropped', reason: `${OFF_REASON}: nothing was sent` });
    }
    if (pending.size >= maxPending) {
      const message = `maxPending (${maxPending}) pushes are already in flight: the event is dropped (call await flush() between bursts, or raise maxPending)`;
      reporter.failure({ kind: 'overflow', message, event: String(event), outcome: 'dropped' });
      return Promise.resolve({ status: 'dropped', reason: message });
    }
    const promise = attempt(event, payload, call ?? {}).catch((error: unknown): PublishResult => {
      const message = `unexpected error in @wadeck-app/queue-sdk: ${getErrorMessage(error)}`;
      reporter.failure({ kind: 'unexpected', message, event: String(event), outcome: 'dropped' });
      return { status: 'dropped', reason: message };
    });
    pending.add(promise);
    void promise.then(() => pending.delete(promise));
    return promise;
  }

  return {
    publish(event, payload, call = {}): void {
      void launch(event, payload, call);
    },
    publishAndWait(event, payload, call = {}): Promise<PublishResult> {
      return launch(event, payload, call);
    },
    async flush(): Promise<void> {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
    async status(): Promise<QueueStatus> {
      if (isOff) {
        return { available: false, reason: OFF_REASON };
      }
      try {
        const state = await resolveShared();
        if (state.state === 'ready') {
          return { available: true, via: 'daemon', daemonVersion: state.daemon.version, protocol: state.daemon.negotiated };
        }
        if (state.state === 'incompatible') {
          return { available: false, reason: state.reason };
        }
        if (startDeps.find() === undefined) {
          return { available: false, reason: `${state.reason}; and queue is not installed or not on PATH: install queue-cli` };
        }
        return { available: true, via: 'queue-start', reason: `${state.reason}; it will be started with \`queue start\` on the first event` };
      } catch (error) {
        return { available: false, reason: `unexpected error in @wadeck-app/queue-sdk: ${getErrorMessage(error)}` };
      }
    },
  };
}
