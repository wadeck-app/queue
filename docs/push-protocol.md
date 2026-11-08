# Push protocol

The wire contract between a client that pushes events (`@wadeck-app/queue-sdk`, `queue push`, any HTTP client) and the queue daemon. Current version: **1.7.0**.

Use `@wadeck-app/queue-sdk` from Node. This page is the reference for the SDK's authors and for clients in other languages.

## Versioning

The protocol has its own SemVer version, independent from every package version. The constants live in `packages/queue-sdk/src/protocol.ts` and are the single source of truth.

| Change | Bump | Compatible with older clients |
|---|---|---|
| Remove or rename a field, change a meaning, add a required request field | MAJOR | No |
| Add an optional request field, a response field, a documented `status` value | MINOR | Yes |
| Clarify this page, fix wording | PATCH | Yes |

- The daemon states the version it implements (`version`) and the SemVer range of client versions it accepts (`accepts`).
- A client states the version it speaks in the request body (`protocol`). Absent means `1.0.0`.
- A new MAJOR keeps the previous MAJOR in `accepts` for at least one release cycle (for example `^1.0.0 || ^2.0.0`). Deprecated MAJORs: none yet.
- **Why SemVer and not the CalVer of the CLI** (decided 2026-10-26, do not reopen without a new fact): the version is negotiated, not read. The daemon states a range it accepts (`^1.0.0`) and a client gates a feature with `>=1.3.0`; a date says nothing about compatibility, would change at every CLI release without any change on the wire, and the range parser does not read it. The CalVer of the release is shown by `queue --version` and by `GET /version` (`version`, beside `queueProtocol.version`); the History table below says which protocol version a change introduced.
- Supported range syntax: `>=`, `>`, `<=`, `<`, `=`, a bare version, `^`, a space for AND, `||` for OR. Prerelease and build metadata are not used.

## Finding the daemon

| Item | Where |
|---|---|
| Config directory | `QUEUE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/queue`, else `~/.config/queue` (empty variables ignored) |
| Port | `<configDir>/config.port`, JSON `{ "sdkVersion", "port", "pid", "startedAt" }`, written while the daemon runs and removed on a clean stop; a crash leaves it behind |
| Token | `<configDir>/health_token`, plain text, never removed |
| Address | `127.0.0.1` only |

A daemon stops itself after about a minute without pending work, so a missing or stale `config.port` is normal: start it with `queue start` (idempotent), then retry.

Before sending the token, check that the file is not stale: `GET /version` must answer with the `pid` of `config.port` and a `config_dir` equal to yours. Otherwise another process may own the port.

## GET /version

No authentication.

```json
{
  "version": "2026.10.23-181-abcdef01",
  "pid": 1234,
  "config_dir": "C:\\Users\\me\\.config\\queue",
  "sdkVersion": 1,
  "port": 47910,
  "queueProtocol": { "version": "1.7.0", "accepts": "^1.0.0" }
}
```

`sdkVersion` belongs to the daemon library (port file and authentication handshake), not to this protocol. A `queueProtocol` that is missing means a daemon older than this page: treat it as `{ "version": "1.0.0", "accepts": "^1.0.0" }`.

## POST /push

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`.

```json
{ "protocol": "1.7.0", "event": "job.started", "payload": { "jobId": "nightly" }, "cwd": "C:/repo", "timeout": 30000 }
```

| Field | Required | Meaning |
|---|---|---|
| `event` | yes | Event name; subscribers match it by pattern (`*` one segment, `>` the rest; a `**` segment is refused in `subscribers.yml`). Names starting with `queue.` are reserved, see [Reserved namespace](#reserved-namespace) |
| `payload` | yes | Any JSON value; `null` when the event carries nothing. Since 1.6.0 a push without it is `rejected`, and so is a payload over **1 MiB** (1048576 bytes of its JSON serialisation: it is copied into the WAL of every subscriber). Send a reference (a path, an id) for bigger data. The SDK refuses both before sending |
| `cwd` | yes, unless `project` is given | Directory used to find the registered project (its subscribers) and the project name. Since 1.3.0 it may be omitted when `project` names the project (an event of a virtual project, which has no folder); with neither, the push is `rejected`. A daemon older than 1.3.0 answers HTTP 500 to a push without `cwd` |
| `protocol` | no | Protocol version the client speaks; absent = `1.0.0` |
| `timeout` | no | Milliseconds the whole `before*` event may take (default 30000). The subscribers run one after the other and share it: each gets what is left, and the chain aborts (naming the subscriber that did not run) once nothing is left. It does not replace the `timeout` of a subscriber in `subscribers.yml`, which applies to `on*` events |
| `replayOf` | no | Id of the event this push replays |
| `project` | no | Since 1.2.0. Id (8 hex characters) of the project of the project registry the event belongs to. The client resolves a name or an alias to the id (and sends a `cwd` inside that project). Absent, the daemon finds the project from `cwd`. A daemon older than 1.2.0 ignores the field, so check `queueProtocol.version` before relying on it |
| `direction` | no | Since 1.4.0. Non-empty list of where the event propagates from its project: `to-parents` (the default when absent) = the project and its ancestors, root first; `to-children` = the project and its descendants, the own subscribers file of each (not the ancestors, not their other ancestors). Give both values to get both; the emitter's own subscribers fire in every case and each subscriber fires once. A subscriber of a descendant is dispatched under the descendant: its WAL, DLQ and event `meta.projectId` carry the descendant's id and `meta.emitterProjectId` the id of the project the event was emitted in; the history outcome and filtered records of that subscriber carry the same two fields, so `queue history --project <id>` (and the dashboard filter) finds the event under the emitter and under each descendant it ran in. An unknown value, an empty list, `to-children` on a `before*` event (synchronous, one answer) or on an event that belongs to no registered project are `rejected` with the reason; nothing is recorded. The history records a non-default `direction`, so `queue replay` propagates the same way. A daemon older than 1.4.0 ignores the field and fires the ancestors only, so check `queueProtocol.version` before relying on it |

Answer, HTTP 200: `{ "ok": true, "result": <PushResponse> }`.

| `result.status` | Meaning | Other fields |
|---|---|---|
| `queued` | Recorded; `on*` subscribers run in the background | `eventId`, `subscriberCount`, `waiterCount`, `waiters` |
| `dispatched` | A `before*` event ran synchronously | `eventId`, `result` (the subscribers' answer), `waiterCount`, `waiters` |
| `aborted` | A subscriber refused, or `subscribers.yml` is invalid | `reason`, `eventId` |
| `rejected` | The client protocol is not accepted, the `project` is not in the registry (or the registry cannot be read), the `event` is in the reserved `queue.` namespace, or (since 1.6.0) the `payload` is absent or over 1 MiB; nothing was recorded | `reason`, `supported` (the accepted range, for a protocol refusal) |

`waiterCount` and `waiters` (since 1.7.0, `queued` and `dispatched` only): the `queue wait` processes waiting for the event at the moment of the push. `waiterCount` is the real number, `waiters` their names (`<who>.<what>`), at most 20. A waiter counts when one of its event patterns matches the event name and all its `--when` filters hold on the event as the history records it; it is not scoped by project, and an `--all` wait counts until it ends. `subscriberCount` is unchanged: waiters are not subscribers. `0` and `[]` mean the daemon looked and nobody waits; both fields are absent when the daemon is older than 1.7.0, when the history record of the push could not be written (a wait reads the history, so it could not have seen the event) and when the daemon could not read the waiter files. A client prints the old wording when they are absent. The push never fails because of them.

A client must treat an unknown `status` as a failure and ignore unknown fields.

| HTTP | Meaning |
|---|---|
| 401 | Missing or wrong token; nothing was recorded, safe to retry with a fresh token |
| 400 / 404 | Malformed request / unknown command |
| 500 | Daemon error, `{ "error": "..." }`. For an `on*` event the WAL is written for all the subscribers in one step, so a 500 means nothing was recorded (the SDK reports `dropped`) and pushing again duplicates nothing |

A connection reset or a timeout after the request was sent leaves the outcome unknown: the event may be recorded. There is no idempotency key, so do not retry blindly. An answer over 1 MiB (a `before*` event whose subscribers returned a huge payload) is not read by the SDK and is reported as `unknown` too: the request was handled, only its answer is lost.

## POST /register-events

Since 1.1.0. Declares the events a program pushes (the event catalog). Same headers and Bearer token as `POST /push`.

```json
{ "protocol": "1.1.0", "source": "orchestrator", "events": [
  { "name": "job.completed", "description": "A job run ended successfully.", "schema": { "type": "object" }, "example": { "jobId": "nightly" },
    "correlationKey": "payload.jobId", "terminal": true, "outcome": "success" }
] }
```

| Field | Required | Rule |
|---|---|---|
| `source` | yes | `[a-z0-9][a-z0-9_-]*`, at most 64 characters; one source per program, it names the stored file |
| `events` | yes | List of at most 500 events; may be empty |
| `events[].name` | yes | Dot-separated segments of `[A-Za-z0-9_-]+`, at most 128 characters; unique in the source |
| `events[].description` | yes | Non-empty, at most 500 characters |
| `events[].schema` | no | JSON Schema object, stored as given, at most 64 KB serialised |
| `events[].example` | no | Any JSON value, at most 16 KB |
| `events[].correlationKey` | no | A dotted payload path (`payload.jobId`) or a list of them |
| `events[].terminal` | no | Boolean: the event ends the thing it is about |
| `events[].outcome` | no | `success`, `failure` or `info` |
| `protocol` | no | As for `push`; absent = `1.0.0` |

A registration replaces everything the same `source` declared before (an empty `events` clears it), is all-or-nothing, and is idempotent. Unknown fields are ignored. Nothing is queued or dispatched, and the daemon never checks a pushed payload against a declared `schema`.

Answer, HTTP 200: `{ "ok": true, "result": <RegisterResponse> }`.

| `result.status` | Meaning | Other fields |
|---|---|---|
| `registered` | Stored | `source`, `count` (number of events) |
| `rejected` | Nothing was stored: the protocol is not accepted, the declaration breaks a rule above, or it uses the source `queue` or an event name starting with `queue.` (since 1.5.0, see [Reserved namespace](#reserved-namespace)) | `reason`; `problems` `[{ "path": "events[3].name", "message": "..." }]` (every problem at once, `path` is empty for the declaration as a whole); `supported` (the accepted range) for a protocol rejection |

| HTTP | Meaning |
|---|---|
| 401 | Missing or wrong token; safe to retry with a fresh token |
| 404 `Unknown command` | The daemon is older than 1.1.0 and does not know the command: do not retry, tell the user to update `queue-cli`. `GET /version` announces it first (`queueProtocol.version` below 1.1.0, or absent) |
| 500 | Daemon error, `{ "error": "..." }` |

A connection reset or a timeout leaves the outcome unknown, but repeating the request is safe because it is idempotent (the SDK retries once).

## Example (any language)

```
curl -s -X POST http://127.0.0.1:47910/push \
  -H "Authorization: Bearer $(cat ~/.config/queue/health_token)" \
  -H "Content-Type: application/json" \
  -d '{"protocol":"1.1.0","event":"demo.hello","payload":{},"cwd":"/path/to/project"}'
```

The port above is the default (47910, override with `QUEUE_DAEMON_PORT`); the daemon takes the next free one up to 47920, so read `config.port`.

## Reserved namespace

Since 1.5.0, event names starting with `queue.` (`queue.dlq.added`, ...) belong to the daemon: it builds those events itself and no client can produce one: no RPC (`give-up`, `give-up-stuck`, `dlq-clear`, `dlq-replay`) accepts event data, they take an id or nothing and the daemon reads its own files. A subscriber on `queue.>` can trust that the event comes from the daemon.

| Entry | Behaviour |
|---|---|
| `POST /push` (`queue push`, the SDK, the relay client, the dashboard) | `rejected` with a `reason` that names the event and says to choose another name; nothing is recorded. Whatever `protocol` the client claims |
| `POST /register-events` | `rejected` for the source `queue` and for an event name starting with `queue.`; nothing is stored |
| `emit` action (`with.event`) | Refused when `subscribers.yml` is loaded, and again at run time (permanent failure) |
| `queue replay`, dashboard replay | Refused for a `queue.*` trigger: a replay is a push |

The daemon does not use these paths for its own events, and a client cannot set the internal `meta.origin` that marks them (an `origin` in a request body is ignored). A daemon older than 1.5.0 accepts such a name from any client: check `queueProtocol.version` before relying on it.

## Actions

`type: action` subscribers (see [subscribers.md](subscribers.md)) change only the `subscribers.yml` schema. The wire is unchanged: an action emits through the daemon's internal push, which has the `/push` semantics, and the hop counter is never a request field.

## History

| Version | Change |
|---|---|
| 1.7.0 | Additive (MINOR): `waiterCount` and `waiters` in the `queued` and `dispatched` answers of `push` (who was waiting for the event). No request change, no new command, `accepts` unchanged. A daemon older than 1.7.0 sends neither: check `queueProtocol.version` before relying on them (`daemonReportsWaiters`). Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.6.0 | Additive (MINOR): two new `rejected` reasons on `push`, a missing `payload` (it was documented as required but never checked) and a payload over 1 MiB (`MAX_PUSH_PAYLOAD_BYTES`); the `timeout` of a `before*` event is one budget for the whole event, not per subscriber. No field is added or removed; a client that sends a payload under 1 MiB is unaffected. A daemon older than 1.6.0 accepts both: check `queueProtocol.version` before relying on it. Recorded in `packages/queue-sdk/contract/protocol-1.json` (a case with a `null` payload; the SDK cannot send the refused ones, they are tested in queue-core) |
| 1.5.0 | Additive (MINOR): the `queue.` event namespace is reserved for events the daemon builds itself. A new `rejected` reason on `push` (an event name starting with `queue.`) and on `register-events` (source `queue`, or a `queue.` event name). No field is added or removed; a client that never used such a name is unaffected. Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.4.0 | Additive (MINOR): the optional `direction` of a push (`to-parents` by default, `to-children`, or both); the descendants' own subscribers fire under their own project id, with `emitterProjectId`. Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.3.0 | Additive (MINOR): `cwd` is optional when `project` is named, so a virtual project (no folder) can emit events. Its subscribers run from their own `cwd:`; one without it fails with the project name. A subscriber always runs from the main folder of the project that owns its file (not the emitter's). Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.2.0 | Additive (MINOR): the optional `project` of a push (id of a project of the project registry) |
| 1.1.0 | Additive (MINOR): the `register-events` command (event catalog); the daemon still accepts clients `^1.0.0`, and a 1.0.0 daemon answers it with HTTP 404. Recorded in `packages/queue-sdk/contract/register-events-1.1.json` |
| 1.0.0 | Initial contract: Bearer token, `event`/`payload`/`cwd`, statuses `queued`, `dispatched`, `aborted`; adds `protocol` and the `rejected` status |
