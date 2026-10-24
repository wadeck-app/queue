# queue-sdk reference

## `createQueuePublisher(options?)`

| Option | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | Project directory sent with every event; selects the project's `.queue/subscribers.yml` and the project name in the history |
| `configDir` | `QUEUE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/queue`, else `~/.config/queue` | Where the queue keeps its files |
| `timeoutMs` | `5000` | HTTP timeout of one push |
| `maxPending` | `100` | Pushes in flight at once; the overflow is dropped and reported |
| `silent` | `false` | `true` prints nothing by default (`onError` is still called) |
| `off` | `false` | **Automated tests only.** `true` sends, starts and reports nothing; every call answers `dropped` with a reason saying so. Never set it in code that runs for real: the shared violations rule `queue-sdk/no-off-outside-tests` (violations CLI >= 2026.10.24-142, active in every project) flags `off` in any file that is not a test. To try a program in development without a queue, use the variable `QUEUE_SDK_OFF` below |
| `onError` | | Receives every failure as `{ kind, message, event, outcome }` |
| `onWarning` | | Receives the daemon's notices (for example a deprecated protocol), each once |

An invalid option falls back to its default and is reported through `onError`.

## Methods

| Method | Returns | Notes |
|---|---|---|
| `publish(event, payload, options?)` | `void` | Fire and forget. Never throws |
| `publishAndWait(event, payload, options?)` | `Promise<PublishResult>` | Never rejects; failures are in the result |
| `registerEvents(source, events)` | `Promise<RegisterResult>` | Declares the events a program pushes; never rejects. See "Declaring your events" |
| `flush()` | `Promise<void>` | Resolves when every push and declaration in flight has settled. Call it before `process.exit()`. It takes no timeout argument: each push is bounded by `timeoutMs` (plus up to 5 s when the daemon has to be started), so `flush()` is bounded too. In a synchronous shutdown hook, start it without awaiting it: pushes still in flight at exit are lost |
| `status()` | `Promise<QueueStatus>` | `{ available, via?, daemonVersion?, protocol?, reason? }`; `via` is `daemon` (running, verified) or `queue-start` (stopped, `queue` found, it will be run on the first event) |

Per-call `options`: `cwd` (overrides the publisher's) and `timeoutMs`.

## `PublishResult.status`

| Status | Meaning |
|---|---|
| `queued` | The daemon recorded the event; `on*` subscribers run in the background. `eventId` is set |
| `dispatched` | A `before*` event ran synchronously; `result` is the subscribers' answer |
| `dropped` | The event was not recorded; `reason` says why and what to do |
| `unknown` | The connection broke or timed out after the request was sent: the event may be recorded. Never retried, to avoid duplicates |

Events whose name starts with `before` are synchronous: the call lasts until the subscribers answer. The daemon allows 30 s by default; with `timeoutMs` set, that value is sent to the daemon as the request timeout and the SDK waits 5 s more. Without it the SDK waits 35 s.

## Declaring your events

`await queue.registerEvents(source, events)` tells the queue which events your program pushes. The daemon stores them (one file per `source`), the dashboard and `queue events` list them, and an agent that must wait for something builds its `queue wait` command from them. It needs a daemon speaking push protocol >= 1.1.0.

```ts
const declared = await queue.registerEvents('orchestrator', [
  {
    name: 'job.completed',
    description: 'A job run ended successfully. Fires once per run id; a retried run has a new id. Does NOT fire for a cancelled or failed run (see job.failed).',
    schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    example: { jobId: 'nightly' },
    correlationKey: 'payload.jobId',
    terminal: true,
    outcome: 'success',
  },
]);
if (declared.status !== 'registered') {
  console.warn(declared.reason);   // already reported through onError; the program keeps working
}
```

- Call it at every start. A registration **replaces** everything `source` declared before; an empty list removes the declarations. It is idempotent, so calling it twice is harmless.
- A declaration is documentation. The SDK and the daemon never check a pushed payload against `schema`.
- It does not publish anything and does not need the events to be pushed first.

| Field | Required | Rule (enforced by the daemon, not the SDK) |
|---|---|---|
| `source` | yes | `[a-z0-9][a-z0-9_-]*`, at most 64 characters; names the file. One per program |
| `name` | yes | Dot-separated segments of `[A-Za-z0-9_-]+`, at most 128 characters; unique inside the source |
| `description` | yes | Non-empty, at most 500 characters |
| `schema` | no | JSON Schema object, stored as given; at most 64 KB serialised |
| `example` | no | Any JSON value, at most 16 KB; prefills the "push test event" form |
| `correlationKey` | no | Dotted payload path such as `payload.jobId`, or a list of them: what identifies the entity the event is about |
| `terminal` | no | `true` when the event ends the thing it is about (completed, failed, timed out...) |
| `outcome` | no | `success`, `failure` or `info` |
| (list) | | At most 500 events per source |

How to write a `description`: say when the event fires, whether it can fire several times for one entity (a step started again on each retry), and what does NOT fire it.

Why `correlationKey`, `terminal` and `outcome` matter: `queue wait` matches an exact event name and filters with `--when payload.path=value`. From these fields an agent derives "wait for job X to finish" (`job.completed` and `job.failed`, `--when "payload.jobId=X"`) instead of guessing.

### `RegisterResult.status`

| Status | Meaning | `onError` kind |
|---|---|---|
| `registered` | Stored; `count` is the number of events | |
| `rejected` | The daemon refused the declaration and stored nothing. `problems` is the daemon's list `[{ path, message }]` (`events[3].name`), `reason` lists each `path: message` | `rejected-declaration` |
| `unsupported` | The daemon is older than protocol 1.1.0 (from `GET /version`, or HTTP 404 to the command). Nothing is retried; pushes keep working. Update `queue-cli` | `unsupported` |
| `dropped` | Nothing was stored: switched off, daemon unreachable, source empty, declaration not JSON-serialisable (`events[0].example.n is a BigInt`), `maxPending` reached | the usual kinds |
| `unknown` | The connection broke or timed out after sending, twice: the declaration may be stored. Call it again | `unknown-outcome` |

Difference with a push: a reset or a timeout after sending is retried **once**, because replacing a source's declaration is idempotent (a push has no idempotency key and is never retried). Everything else (discovery, verification, start on demand, the 401 retry, `off` / `QUEUE_SDK_OFF`, `maxPending`, `flush()`) is shared with `publish`. The SDK checks only that `source` is a non-empty string and that the declaration is JSON-serialisable; every other rule is the daemon's, so the SDK never disagrees with it. In `onError` a declaration failure has `operation: 'register-events'` and `event` is the source.

## Testing your integration

Three ways, none touches the real daemon:

- **Automated tests, the real SDK path:** `@wadeck-app/queue-sdk/testing` starts a throwaway daemon on a free port in a temporary config dir (version check, token, push, answers).
- **Automated tests, no SDK at all:** `createQueuePublisher({ off: true })` sends nothing. Test files only (a lint rule enforces it).
- **Trying the program in development:** run it with the environment variable `QUEUE_SDK_OFF=1`. Nothing is sent or started, calls answer `dropped` saying why, and a warning is announced once when the publisher is created (to `onWarning`, else printed unless `silent`), so a variable forgotten in production is not silent. Unset, empty or `0` keep the SDK active; any other value is reported as a mistake through `onError` and the SDK stays active, so a typo cannot lose events.

```ts
import { createQueuePublisher } from '@wadeck-app/queue-sdk';
import { startFakeQueueDaemon } from '@wadeck-app/queue-sdk/testing';

const daemon = await startFakeQueueDaemon();
const queue = createQueuePublisher({ configDir: daemon.configDir, silent: true });
await queue.publishAndWait('myapp.thing', { n: 1 });
daemon.pushes();            // [{ event: 'myapp.thing', payload: { n: 1 }, cwd: '...', protocol: '1.1.0' }]
await queue.registerEvents('myapp', [{ name: 'myapp.thing', description: 'A thing happened.' }]);
daemon.registrations();     // [{ source: 'myapp', events: [...], protocol: '1.1.0' }]
daemon.respondNextRegistration({ status: 'rejected', reason: '...', problems: [{ path: 'events[0].name', message: '...' }] });
daemon.respondNext({ status: 'aborted', reason: 'refused' });   // the next push gets this result
daemon.resetNext();         // the next push breaks the connection: the SDK answers `unknown`
await daemon.close();       // also removes the temporary config dir
```

It speaks the protocol of this SDK release and records pushes and declarations in order; it has no subscribers and runs nothing. It does not validate declarations (the rules belong to the daemon): use `respondNextRegistration` to test your handling of a `rejected` answer. `startFakeQueueDaemon({ protocolVersion: '1.0.0' })` behaves like a daemon without the event catalog: `registerEvents` answers `unsupported`, `registrations()` stays empty, and a client that sends the command anyway gets HTTP 404 `Unknown command`.

## Other exports

`resolveConfigDir(env?, home?)` returns the directory the queue uses. `PROTOCOL_VERSION` is the push protocol version this SDK speaks. Types: `QueuePublisher`, `QueuePublisherOptions`, `PublishOptions`, `PublishResult`, `EventDeclaration`, `RegisterResult`, `QueueStatus`, `QueueFailure`, `FailureKind`.

## How it reaches the daemon

1. Reads `<configDir>/config.port` (port and pid) and checks, without a token, that `GET /version` on that port reports the same pid and the same config directory. The token is never sent to an unverified process.
2. Reads `<configDir>/health_token` and sends `POST /push` (or `POST /register-events`) with it. The body carries the event, the payload, the absolute `cwd` and the protocol version.
3. Stopped daemon: finds `queue` on `PATH`, runs `queue start` once for all concurrent publishes, waits up to 5 s for the daemon to answer, then sends.
4. A 401 re-reads the token and retries once. A refused connection retries once after a start. A reset or a timeout is never retried for a push (one retry for `registerEvents`, which is idempotent).

The payload only travels over HTTP, never on a command line. On Windows `queue` is a `.cmd` shim, run through the shell with a constant command; a `queue` path containing `" % ^ ! & | < >` is refused.

## Versioning

The push protocol has its own SemVer version, independent from this package's. MAJOR is breaking, MINOR additive, PATCH no wire change.

- The daemon announces its protocol version and the range of client versions it accepts in `GET /version` (`queueProtocol`). A daemon without it is treated as `1.0.0`.
- The SDK checks both directions before sending and, when the versions do not overlap, drops the event with a message naming both versions and the package to update.
- A new MAJOR keeps the previous one accepted for at least one release cycle.
- The package version follows the CLI's calendar versioning; use a range such as `^` only if you accept new MINORs of the protocol.

The wire contract: [push-protocol.md](https://github.com/wadeck-app/queue/blob/main/docs/push-protocol.md).
