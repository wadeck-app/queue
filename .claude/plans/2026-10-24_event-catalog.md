# Event catalog: every CLI declares its events, the Events page documents them

Status: draft for validation. Nothing is implemented.

## Goal

Each program that pushes events declares them once (name, description, JSON Schema of the payload). The queue stores the declarations and shows them in an "Events" page and in `queue events`, so the list of events is documentation that cannot go stale: it comes from the code that pushes them.

## Decisions

| Topic | Decision |
|---|---|
| Who declares | The publisher, through the SDK: `queue.registerEvents(source, events)` |
| Transport | New daemon command `register-events`, protocol 1.1.0 (MINOR: additive, old clients and old daemons keep working) |
| Storage | The daemon writes `<configDir>/events/<source>.json` (one file per source, written to a temporary file then renamed); readers (the dashboard, the CLI) read the files directly, like the WAL and the history |
| Idempotent | A registration replaces everything the same `source` declared before; calling it at every start is the expected use |
| Observed but undeclared | The page also lists event names seen in the history (last 7 days) that nobody declared, marked "undocumented", so gaps are visible |
| Payload validation | Not done: the schema documents, it does not reject (see "Out of scope") |
| Page | "Queue Events": table with search and source filter, expandable schema, and actions (see below) |
| CLI parity | `queue events list [--source S] [--json]`, `queue events show <name>`, `queue events register --source S --file <events.json>` (for programs that do not use Node) |

## Declaration format

```json
{ "source": "orchestrator",
  "events": [
    { "name": "job.started", "description": "A job run began.", "schema": { "type": "object", "properties": { "jobId": { "type": "string" } }, "required": ["jobId"] }, "example": { "jobId": "nightly" } }
  ] }
```

| Field | Rule |
|---|---|
| `source` | Required, `[a-z0-9][a-z0-9_-]*`, at most 64 characters; names the file |
| `name` | Required, dot-separated segments of `[A-Za-z0-9_-]+`, at most 128 characters; unique inside the source |
| `description` | Required, non-empty, at most 500 characters |
| `schema` | Optional JSON Schema object (stored as given, not interpreted); at most 64 KB serialised |
| `example` | Optional JSON value, at most 16 KB; used to prefill the "Push test event" form |
| Limits | At most 500 events per source |

Every violation is reported with its path (`events[3].name`) and the rule, as a `rejected` answer; nothing is stored when any event is invalid.

## Protocol 1.1.0

`POST /register-events` with the same Bearer token and `protocol` field as `push`. Answer: `{ ok: true, result: { status: 'registered', source, count } }` or `{ status: 'rejected', reason, problems: [{ path, message }] }`.

- Daemon version `1.1.0`; it still accepts clients `^1.0.0`. SDK speaks `1.1.0`; understands `^1.0.0`.
- `registerEvents` on a daemon below 1.1.0 answers `unsupported` with "update queue-cli"; `publish` keeps working.
- `contract/protocol-1.json` gains the register cases; `docs/push-protocol.md` gets the 1.1.0 row in its history.

## SDK

`await queue.registerEvents(source, events)` returns `{ status: 'registered' | 'rejected' | 'unsupported' | 'dropped', count?, problems?, reason? }`; never rejects, same failure reporting and daemon start as `publish`. The `testing` fake daemon records registrations (`daemon.registrations()`).

## Dashboard

New route `GET /events`: catalog merged with the last 24 h counts, the subscribers whose pattern matches each name, and the observed-but-undeclared names. New page "Queue Events" (path `/events`).

| Where | Action |
|---|---|
| Row | "History" link to `History?event=<name>`; "Subscribers" link to the Subscribers page |
| Row, expanded | JSON Schema and example (JsonViewer) |
| Row | "Push test event" with the example prefilled and a confirmation (it runs the real subscribers) |
| Undocumented row | Shows how many pushes were seen and which cwd pushed it, so the owner can be found |
| Source header | When it registered last; a source not seen for a long time is marked stale |

## Adoption

Each owner declares its events once at start (daemon) or on install (short-lived CLI): orchestrator (`job.*`, `alert.*`, `exec.*`, `daemon.*`), task (`onTaskCreated`, `onStatusChange`...), flow (`flow.execution.*`, `flow.step.*`). I message them when 1.1.0 is published.

## Tests (TDD, the backlog)

- Validation: every rule above, with the path in the message.
- Store: atomic replace per source, concurrent registrations of two sources, a corrupt file is reported and skipped.
- Daemon over HTTP (real daemon, free port): register, replace, reject, old client without `protocol`.
- SDK: against the fake daemon and against a 1.0.0 daemon fixture (`unsupported`).
- Dashboard route and page structure guards (`viewsRoutes.test.ts`), CLI commands.
- Contract fixtures replayed on both sides.

## Out of scope

- Validating pushed payloads against the schema (would need a validator dependency; the schema is documentation; can be added later as a warning).
- Versioning of an event's schema (one current schema per name).
- Declaring subscribers or changing `subscribers.yml`.
- Declarations from programs that cannot run `queue events register`.

## Open questions

1. Payload validation as an opt-in warning later (`queue push` and the dashboard form could warn when the example does not match): wanted?
2. Sources that disappear (uninstalled CLI): keep them with a "stale" mark (proposed), or add `queue events forget <source>`?
