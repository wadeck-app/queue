# queue-sdk reference

## `createQueuePublisher(options?)`

| Option | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | Project directory sent with every event; selects the project's `.queue/subscribers.yml` and the project name in the history |
| `configDir` | `QUEUE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/queue`, else `~/.config/queue` | Where the queue keeps its files |
| `timeoutMs` | `5000` | HTTP timeout of one push |
| `maxPending` | `100` | Pushes in flight at once; the overflow is dropped and reported |
| `silent` | `false` | `true` prints nothing by default (`onError` is still called) |
| `onError` | | Receives every failure as `{ kind, message, event, outcome }` |
| `onWarning` | | Receives the daemon's notices (for example a deprecated protocol), each once |

An invalid option falls back to its default and is reported through `onError`.

## Methods

| Method | Returns | Notes |
|---|---|---|
| `publish(event, payload, options?)` | `void` | Fire and forget. Never throws |
| `publishAndWait(event, payload, options?)` | `Promise<PublishResult>` | Never rejects; failures are in the result |
| `flush()` | `Promise<void>` | Resolves when every push in flight has settled. Call it before `process.exit()` |
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

## Other exports

`resolveConfigDir(env?, home?)` returns the directory the queue uses. `PROTOCOL_VERSION` is the push protocol version this SDK speaks. Types: `QueuePublisher`, `QueuePublisherOptions`, `PublishOptions`, `PublishResult`, `QueueStatus`, `QueueFailure`, `FailureKind`.

## How it reaches the daemon

1. Reads `<configDir>/config.port` (port and pid) and checks, without a token, that `GET /version` on that port reports the same pid and the same config directory. The token is never sent to an unverified process.
2. Reads `<configDir>/health_token` and sends `POST /push` with it. The body carries the event, the payload, the absolute `cwd` and the protocol version.
3. Stopped daemon: finds `queue` on `PATH`, runs `queue start` once for all concurrent publishes, waits up to 5 s for the daemon to answer, then sends.
4. A 401 re-reads the token and retries once. A refused connection retries once after a start. A reset or a timeout is never retried.

The payload only travels over HTTP, never on a command line. On Windows `queue` is a `.cmd` shim, run through the shell with a constant command; a `queue` path containing `" % ^ ! & | < >` is refused.

## Versioning

The push protocol has its own SemVer version, independent from this package's. MAJOR is breaking, MINOR additive, PATCH no wire change.

- The daemon announces its protocol version and the range of client versions it accepts in `GET /version` (`queueProtocol`). A daemon without it is treated as `1.0.0`.
- The SDK checks both directions before sending and, when the versions do not overlap, drops the event with a message naming both versions and the package to update.
- A new MAJOR keeps the previous one accepted for at least one release cycle.
- The package version follows the CLI's calendar versioning; use a range such as `^` only if you accept new MINORs of the protocol.

The wire contract: [push-protocol.md](https://github.com/wadeck-app/queue/blob/main/docs/push-protocol.md).
