import { getErrorMessage } from './errors.js';
import { resolve } from 'node:path';
import { createDaemonResolver, isPidAlive, type DaemonInfo, type Resolution } from './daemon.js';
import { loopbackRequest, type HttpOutcome, type LoopbackRequest } from './http.js';
import { resolveConfigDir } from './configDir.js';
import { daemonSupportsEventCatalog, daemonSupportsPushProject, EVENT_CATALOG_MIN_VERSION, PROTOCOL_VERSION, PUSH_PROJECT_MIN_VERSION } from './protocol.js';
import { createReporter, describeHttpError, type FailureKind, type QueueFailure, type Reporter } from './report.js';
import { defaultStartDeps, startDaemon, type RunOutcome, type StartDeps, type StartResult } from './start.js';
import {
  parsePushAnswer,
  parseRegisterAnswer,
  serializePushRequest,
  serializeRegisterRequest,
  toPublishResult,
  type EventDeclaration,
  type PublishResult,
  type PushRequest,
  type PushResponse,
  type RegisterResult,
  type Serialized,
} from './wire.js';

/** A project id of the project registry: 8 lowercase hexadecimal characters. */
const PROJECT_ID = /^[0-9a-f]{8}$/;

export interface QueuePublisherOptions {
  /** Project directory sent with every event (selects `.queue/subscribers.yml`). Default `process.cwd()`. */
  cwd?: string;
  /**
   * Id of the project (8 hexadecimal characters, see `project list`) every event is pushed on behalf of. Absent: the daemon finds the
   * project from `cwd`. The SDK does not resolve names: resolve a name or an alias to its id first. Needs queue-cli >= push protocol 1.2.0.
   */
  project?: string;
  /** Queue config dir. Default: QUEUE_CONFIG_DIR, else $XDG_CONFIG_HOME/queue, else ~/.config/queue. */
  configDir?: string;
  /** HTTP timeout in ms of a fire-and-forget push. Default 5000. */
  timeoutMs?: number;
  /** Largest number of pushes in flight; the overflow is dropped and reported. Default 100. */
  maxPending?: number;
  /** True: nothing is printed by default (`onError` is still called). */
  silent?: boolean;
  /**
   * True: nothing is sent, started or reported; every call answers `dropped` saying so. FOR AUTOMATED TESTS ONLY: the violations rule
   * queue-sdk/no-off-outside-tests flags it outside test files. To try a program in development without a queue, set the environment variable QUEUE_SDK_OFF=1 instead.
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
  /** Overrides the publisher's `project` for this event. */
  project?: string;
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
  /**
   * Declares the events a program pushes (the event catalog, push protocol 1.1.0). Call it at every start: it REPLACES everything
   * `source` declared before. Never rejects, never throws: `registered`, `rejected` (the daemon refused the declaration, `problems`
   * says why), `unsupported` (the daemon is older than 1.1.0: update queue-cli), `dropped` (nothing sent or stored), or `unknown`.
   * Unlike a push it is retried once after a connection reset or a timeout, because repeating it is harmless.
   */
  registerEvents(source: string, events: EventDeclaration[]): Promise<RegisterResult>;
  /** Resolves when every push and declaration in flight has settled. */
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

type Outcome = 'dropped' | 'unknown';

/** One command sent to the daemon: what differs between a push and a registration. Everything else is shared (see `exchange`). */
interface Exchange<R> {
  path: string;
  httpTimeout: number;
  /** Repeat the request once after a connection reset or a timeout. Only for a command that is safe to repeat. */
  retryAmbiguous: boolean;
  /** The JSON body for the given protocol version. */
  body(protocol: string): Serialized;
  /** Reports the failure and builds the result. */
  fail(kind: FailureKind, message: string, outcome?: Outcome): R;
  /** The message when the outcome stays unknown; `cause` says what happened. */
  ambiguous(cause: string): string;
  /** Once the daemon is verified, before anything is sent: a result stops the exchange. */
  precheck?(daemon: DaemonInfo): R | undefined;
  /** On HTTP 404: a result stops the exchange; undefined leaves it to the generic HTTP error. */
  notFound?(daemon: DaemonInfo, text: string): R | undefined;
  interpret(daemon: DaemonInfo, text: string): R;
}

type Ensured ={ ok: true; daemon: DaemonInfo; token: string } | { ok: false; kind: FailureKind; message: string };

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

  // The shared machinery of every command sent to the daemon: discovery, verification, start on demand, the 401 and the
  // refused-connection retries, and the failure reporting. A command only says what differs (see `Exchange`).
  async function exchange<R>(ex: Exchange<R>): Promise<R> {
    const first = ex.body(PROTOCOL_VERSION);
    if (!first.ok) {
      return ex.fail('not-serialisable', first.reason);
    }

    let authRetried = false;
    let restartRetried = false;
    let ambiguousRetried = false;
    for (;;) {
      const ensured = await ensureDaemon();
      if (!ensured.ok) {
        return ex.fail(ensured.kind, ensured.message);
      }
      const { daemon, token } = ensured;
      const early = ex.precheck?.(daemon);
      if (early !== undefined) {
        return early;
      }
      let body = first.body;
      if (daemon.negotiated !== PROTOCOL_VERSION) {
        const again = ex.body(daemon.negotiated);
        body = again.ok ? again.body : body;
      }
      const outcome = await request({
        port: daemon.port,
        method: 'POST',
        path: ex.path,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        timeoutMs: ex.httpTimeout,
      });
      if (outcome.kind === 'failure') {
        resolver.invalidate();
        if (!outcome.connected && outcome.code === 'ECONNREFUSED') {
          if (!restartRetried) {
            restartRetried = true;
            continue;
          }
          return ex.fail('not-ready', `the daemon refused the connection on port ${daemon.port} again after being started: run \`queue status\` in a terminal`);
        }
        if (!outcome.connected) {
          return ex.fail('unexpected', `could not reach the daemon on port ${daemon.port}: ${outcome.message}`);
        }
        if (ex.retryAmbiguous && !ambiguousRetried) {
          ambiguousRetried = true;
          continue;
        }
        const cause = outcome.timedOut ? `no answer within ${ex.httpTimeout} ms` : `the connection broke while the daemon was handling the request (${outcome.message})`;
        return ex.fail('unknown-outcome', ex.ambiguous(cause), 'unknown');
      }
      if (outcome.status === 401) {
        resolver.invalidate();
        if (!authRetried) {
          authRetried = true;
          continue;
        }
        return ex.fail('unauthorized', describeHttpError(401, outcome.text, [token]));
      }
      if (outcome.status === 404) {
        const missing = ex.notFound?.(daemon, outcome.text);
        if (missing !== undefined) {
          return missing;
        }
      }
      if (outcome.status !== 200) {
        return ex.fail('http-error', describeHttpError(outcome.status, outcome.text, [token]));
      }
      return ex.interpret(daemon, outcome.text);
    }
  }

  async function attempt(event: string, payload: unknown, call: PublishOptions): Promise<PublishResult> {
    const fail = (kind: FailureKind, message: string, outcome: Outcome = 'dropped'): PublishResult => {
      reporter.failure({ kind, message, event, outcome });
      return { status: outcome === 'unknown' ? 'unknown' : 'dropped', reason: message };
    };
    if (typeof event !== 'string' || event.trim() === '') {
      return fail('invalid-argument', `the event name must be a non-empty string such as "myapp.thing_done", got ${JSON.stringify(event) ?? String(event)}`);
    }
    if (call.timeoutMs !== undefined && !isPositiveNumber(call.timeoutMs)) {
      return fail('invalid-argument', `timeoutMs must be a positive number of milliseconds, got ${String(call.timeoutMs)}`);
    }
    const project = call.project ?? options.project;
    if (project !== undefined && !PROJECT_ID.test(project)) {
      return fail(
        'invalid-argument',
        `project must be the id of a registered project (8 hexadecimal characters, \`project list\` shows them), got ${JSON.stringify(project)}: resolve a name or an alias to its id first`,
      );
    }
    const isBefore = event.startsWith('before');
    const requestTimeout = isBefore ? call.timeoutMs : undefined;
    const httpTimeout = isBefore ? (requestTimeout ?? DAEMON_BEFORE_TIMEOUT_MS) + BEFORE_MARGIN_MS : (call.timeoutMs ?? timeoutMs);
    const wire: PushRequest = { event, payload, cwd: resolve(call.cwd ?? defaultCwd), protocol: PROTOCOL_VERSION, ...(requestTimeout !== undefined && { timeout: requestTimeout }), ...(project !== undefined && { project }) };
    return exchange<PublishResult>({
      path: '/push',
      httpTimeout,
      // A reset or a timeout after sending may have recorded the event, and there is no idempotency key: never retried.
      retryAmbiguous: false,
      body: (protocol) => serializePushRequest({ ...wire, protocol }),
      fail,
      // An older daemon would ignore the project and file the event under the project of the cwd: drop it instead, and say why
      ...(project !== undefined && {
        precheck: (daemon: DaemonInfo): PublishResult | undefined =>
          daemonSupportsPushProject(daemon.protocol.version)
            ? undefined
            : fail('unsupported', `the daemon speaks push protocol ${daemon.protocol.version} and the project of an event needs ${PUSH_PROJECT_MIN_VERSION}: it would ignore the project and file the event under another. Update queue-cli (\`queue cli update\`), or publish without a project`),
      }),
      ambiguous: (cause) => `${cause}: the event may have been queued, it is not retried (raise timeoutMs if the daemon is slow)`,
      interpret: (daemon, text) => interpret(daemon, text, fail),
    });
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
      // `supported` is the accepted range of a protocol refusal; without it the daemon refused something else (an unknown project)
      if (response.supported === undefined) {
        return fail('rejected', `the daemon rejected the event: ${response.reason ?? 'no reason given'}`);
      }
      const accepted = response.supported ?? daemon.protocol.accepts;
      return fail(
        'rejected',
        `the daemon rejected the event${response.reason !== undefined ? ` (${response.reason})` : ''}: this SDK speaks push protocol ${PROTOCOL_VERSION}, the daemon (protocol ${daemon.protocol.version}) accepts ${accepted}: update @wadeck-app/queue-sdk or queue-cli so that the versions overlap`,
      );
    }
    reporter.success();
    return toPublishResult(response);
  }

  async function registerAttempt(source: string, events: EventDeclaration[]): Promise<RegisterResult> {
    const label = typeof source === 'string' ? source : '(registerEvents)';
    const fail = (kind: FailureKind, message: string, outcome: Outcome = 'dropped'): RegisterResult => {
      reporter.failure({ kind, message, event: label, outcome, operation: 'register-events' });
      return { status: outcome === 'unknown' ? 'unknown' : 'dropped', reason: message };
    };
    if (typeof source !== 'string' || source.trim() === '') {
      return fail('invalid-argument', `the source must be a non-empty string naming the program that declares the events, such as "orchestrator", got ${JSON.stringify(source) ?? String(source)}`);
    }
    const unsupported = (daemonProtocolVersion: string, prefix: string): RegisterResult => {
      const message = `${prefix}update queue-cli (the queue daemon speaks push protocol ${daemonProtocolVersion}, the event catalog needs ${EVENT_CATALOG_MIN_VERSION}); publishing events is not affected`;
      reporter.failure({ kind: 'unsupported', message, event: label, outcome: 'dropped', operation: 'register-events' });
      return { status: 'unsupported', reason: message };
    };
    return exchange<RegisterResult>({
      path: '/register-events',
      httpTimeout: timeoutMs,
      // Registering replaces the whole declaration of the source: repeating it after an unknown outcome is safe.
      retryAmbiguous: true,
      body: (protocol) => serializeRegisterRequest({ protocol, source, events }),
      fail,
      ambiguous: (cause) => `${cause}, twice: the declaration may have been stored. Registering replaces the previous declaration, so calling registerEvents again is safe (raise timeoutMs if the daemon is slow)`,
      precheck: (daemon) => (daemonSupportsEventCatalog(daemon.protocol.version) ? undefined : unsupported(daemon.protocol.version, '')),
      notFound: (daemon) => unsupported(daemon.protocol.version, 'the daemon does not know the register-events command (HTTP 404): '),
      interpret: (daemon, text) => interpretRegistration(daemon, text, source, fail),
    });
  }

  function interpretRegistration(daemon: DaemonInfo, text: string, source: string, fail: (kind: FailureKind, message: string) => RegisterResult): RegisterResult {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return fail('bad-answer', `the daemon answered something that is not JSON (${getErrorMessage(error)}): ${text.slice(0, 200)}`);
    }
    const parsed = parseRegisterAnswer(json);
    if (!parsed.ok) {
      return fail('bad-answer', parsed.reason);
    }
    const response = parsed.response;
    if (response.status === 'rejected') {
      const problems = response.problems ?? [];
      const listed = problems.map((problem) => `${problem.path === '' ? 'declaration' : problem.path}: ${problem.message}`).join('; ');
      const detail =
        problems.length > 0
          ? listed
          : `${response.reason ?? 'no reason given'}${response.supported !== undefined ? ` (the daemon, protocol ${daemon.protocol.version}, accepts ${response.supported}; this SDK speaks ${PROTOCOL_VERSION}: update @wadeck-app/queue-sdk or queue-cli so that the versions overlap)` : ''}`;
      const reason = `the daemon rejected the declaration of "${source}": ${detail}`;
      reporter.failure({ kind: 'rejected-declaration', message: reason, event: source, outcome: 'dropped', operation: 'register-events' });
      return { status: 'rejected', ...(problems.length > 0 && { problems }), reason };
    }
    reporter.success();
    return { status: 'registered', ...(response.count !== undefined && { count: response.count }) };
  }

  const pending = new Set<Promise<unknown>>();

  const envOff = readOffVariable(deps.env ?? process.env, reporter);
  const isOff = options.off === true || envOff;
  const OFF_REASON = options.off === true ? 'the publisher is switched off (option off: true)' : 'the publisher is switched off by the environment variable QUEUE_SDK_OFF=1';

  interface Launch<R> {
    /** The event name (or the source) a failure is reported for. */
    label: string;
    operation?: 'register-events';
    overflow: string;
    work: () => Promise<R>;
    dropped: (reason: string) => R;
  }

  // The single accounting of the work in flight (maxPending, flush, off), shared by pushes and registrations.
  function launch<R>(spec: Launch<R>): Promise<R> {
    const operation = spec.operation === undefined ? {} : { operation: spec.operation };
    if (isOff) {
      return Promise.resolve(spec.dropped(`${OFF_REASON}: nothing was sent`));
    }
    if (pending.size >= maxPending) {
      reporter.failure({ kind: 'overflow', message: spec.overflow, event: spec.label, outcome: 'dropped', ...operation });
      return Promise.resolve(spec.dropped(spec.overflow));
    }
    const promise = spec.work().catch((error: unknown): R => {
      const message = `unexpected error in @wadeck-app/queue-sdk: ${getErrorMessage(error)}`;
      reporter.failure({ kind: 'unexpected', message, event: spec.label, outcome: 'dropped', ...operation });
      return spec.dropped(message);
    });
    pending.add(promise);
    void promise.then(() => pending.delete(promise));
    return promise;
  }

  function launchPush(event: string, payload: unknown, call: PublishOptions): Promise<PublishResult> {
    return launch<PublishResult>({
      label: String(event),
      overflow: `maxPending (${maxPending}) pushes are already in flight: the event is dropped (call await flush() between bursts, or raise maxPending)`,
      work: () => attempt(event, payload, call ?? {}),
      dropped: (reason) => ({ status: 'dropped', reason }),
    });
  }

  return {
    publish(event, payload, call = {}): void {
      void launchPush(event, payload, call);
    },
    publishAndWait(event, payload, call = {}): Promise<PublishResult> {
      return launchPush(event, payload, call);
    },
    registerEvents(source, events): Promise<RegisterResult> {
      return launch<RegisterResult>({
        label: typeof source === 'string' ? source : '(registerEvents)',
        operation: 'register-events',
        overflow: `maxPending (${maxPending}) pushes or declarations are already in flight: the declaration is dropped (call await flush() between bursts, or raise maxPending)`,
        work: () => registerAttempt(source, events),
        dropped: (reason) => ({ status: 'dropped', reason }),
      });
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
