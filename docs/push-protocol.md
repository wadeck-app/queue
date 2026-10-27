# Push protocol

The wire contract between a client that pushes events (`@wadeck-app/queue-sdk`, `queue push`, any HTTP client) and the queue daemon. Current version: **1.4.0**.

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
  "queueProtocol": { "version": "1.4.0", "accepts": "^1.0.0" }
}
```

`sdkVersion` belongs to the daemon library (port file and authentication handshake), not to this protocol. A `queueProtocol` that is missing means a daemon older than this page: treat it as `{ "version": "1.0.0", "accepts": "^1.0.0" }`.

## POST /push

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`.

```json
{ "protocol": "1.4.0", "event": "job.started", "payload": { "jobId": "nightly" }, "cwd": "C:/repo", "timeout": 30000 }
```

| Field | Required | Meaning |
|---|---|---|
| `event` | yes | Event name; subscribers match it by pattern (`*` one segment, `**` or `>` the rest) |
| `payload` | yes | Any JSON value |
| `cwd` | yes, unless `project` is given | Directory used to find the registered project (its subscribers) and the project name. Since 1.3.0 it may be omitted when `project` names the project (an event of a virtual project, which has no folder); with neither, the push is `rejected`. A daemon older than 1.3.0 answers HTTP 500 to a push without `cwd` |
| `protocol` | no | Protocol version the client speaks; absent = `1.0.0` |
| `timeout` | no | Milliseconds a `before*` event may take (default 30000) |
| `replayOf` | no | Id of the event this push replays |
| `project` | no | Since 1.2.0. Id (8 hex characters) of the project of the project registry the event belongs to. The client resolves a name or an alias to the id (and sends a `cwd` inside that project). Absent, the daemon finds the project from `cwd`. A daemon older than 1.2.0 ignores the field, so check `queueProtocol.version` before relying on it |
| `direction` | no | Since 1.4.0. Non-empty list of where the event propagates from its project: `to-parents` (the default when absent) = the project and its ancestors, root first; `to-children` = the project and its descendants, the own subscribers file of each (not the ancestors, not their other ancestors). Give both values to get both; the emitter's own subscribers fire in every case and each subscriber fires once. A subscriber of a descendant is dispatched under the descendant: its WAL, DLQ and event `meta.projectId` carry the descendant's id and `meta.emitterProjectId` the id of the project the event was emitted in; the history outcome and filtered records of that subscriber carry the same two fields, so `queue history --project <id>` (and the dashboard filter) finds the event under the emitter and under each descendant it ran in. An unknown value, an empty list, `to-children` on a `before*` event (synchronous, one answer) or on an event that belongs to no registered project are `rejected` with the reason; nothing is recorded. The history records a non-default `direction`, so `queue replay` propagates the same way. A daemon older than 1.4.0 ignores the field and fires the ancestors only, so check `queueProtocol.version` before relying on it |

Answer, HTTP 200: `{ "ok": true, "result": <PushResponse> }`.

| `result.status` | Meaning | Other fields |
|---|---|---|
| `queued` | Recorded; `on*` subscribers run in the background | `eventId`, `subscriberCount` |
| `dispatched` | A `before*` event ran synchronously | `eventId`, `result` (the subscribers' answer) |
| `aborted` | A subscriber refused, or `subscribers.yml` is invalid | `reason`, `eventId` |
| `rejected` | The client protocol is not accepted, or the `project` is not in the registry (or the registry cannot be read); nothing was recorded | `reason`, `supported` (the accepted range, for a protocol refusal) |

A client must treat an unknown `status` as a failure and ignore unknown fields.

| HTTP | Meaning |
|---|---|
| 401 | Missing or wrong token; nothing was recorded, safe to retry with a fresh token |
| 400 / 404 | Malformed request / unknown command |
| 500 | Daemon error, `{ "error": "..." }` |

A connection reset or a timeout after the request was sent leaves the outcome unknown: the event may be recorded. There is no idempotency key, so do not retry blindly.

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
| `rejected` | Nothing was stored: the protocol is not accepted, or the declaration breaks a rule above | `reason`; `problems` `[{ "path": "events[3].name", "message": "..." }]` (every problem at once, `path` is empty for the declaration as a whole); `supported` (the accepted range) for a protocol rejection |

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

The port above is the default (47910); the daemon takes the next free one up to 47920, so read `config.port`.

## History

| Version | Change |
|---|---|
| 1.4.0 | Additive (MINOR): the optional `direction` of a push (`to-parents` by default, `to-children`, or both); the descendants' own subscribers fire under their own project id, with `emitterProjectId`. Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.3.0 | Additive (MINOR): `cwd` is optional when `project` is named, so a virtual project (no folder) can emit events. Its subscribers run from their own `cwd:`; one without it fails with the project name. A subscriber always runs from the main folder of the project that owns its file (not the emitter's). Recorded in `packages/queue-sdk/contract/protocol-1.json` |
| 1.2.0 | Additive (MINOR): the optional `project` of a push (id of a project of the project registry) |
| 1.1.0 | Additive (MINOR): the `register-events` command (event catalog); the daemon still accepts clients `^1.0.0`, and a 1.0.0 daemon answers it with HTTP 404. Recorded in `packages/queue-sdk/contract/register-events-1.1.json` |
| 1.0.0 | Initial contract: Bearer token, `event`/`payload`/`cwd`, statuses `queued`, `dispatched`, `aborted`; adds `protocol` and the `rejected` status |
