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
| `description` | Required, non-empty, at most 500 characters. Convention for owners (in the SDK docs): say when it fires, whether it can fire several times for one entity (a step started again on each retry), and what does NOT fire it |
| `schema` | Optional JSON Schema object (stored as given, not interpreted); at most 64 KB serialised |
| `example` | Optional JSON value, at most 16 KB; used to prefill the "Push test event" form |
| `correlationKey` | Optional string or list of dotted payload paths that identify the entity the event is about (`payload.jobId`); `queue wait` filters by exact name and `--when`, so an agent needs it to wait for one entity |
| `terminal` | Optional boolean: this event ends the thing it is about (a job completed, failed, timed out...) |
| `outcome` | Optional `success`, `failure` or `info`; with `terminal`, lets an agent build "wait for the job to finish" from the catalog |
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

## For agents (the poll-event skill)

Requirements gathered from claude-owner. An agent that must wait for something asks the catalog instead of guessing or reading hand-written tables.

| Command | Contract |
|---|---|
| `queue events list [--source S] [--prefix flow.] [--match "flow.>"] [--declared-only] [--terminal] [--json]` | `--match` uses the subscribers.yml pattern syntax. JSON: `{ "events": [...], "total": N }`, entries without schemas: `name`, `source`, `description`, `declared` (false for names seen in the history that nobody declared, listed, not hidden), `terminal`, `outcome`, `correlationKey`, `lastSeenAt`, `count24h`; sources carry `registeredAt` so a stale source is visible |
| `queue events show <name> [--json]` | Schema and example, a flat `filterable` list (`payload.jobId`, type, required) because `--when` takes `payload.path=value`, the `correlationKey`, and a ready `waitExample` (`queue wait job.completed --when "payload.jobId=<jobId>" --since 5m --json`). Unknown name: exit 4 (invalid usage, same as `wait`) with the nearest declared names |
| `queue wait <name>` | An undeclared name still waits (old or undeclared producers exist) but warns on stderr with the nearest declared names; with `--json` the result carries `declared: false` and `suggestions`, and on timeout `lastSeenAt` of that name from the history (null = never seen: a typo or a rename, as opposed to a slow producer). `--strict`: an unknown name is exit 4 at once. Exit 2 and 3 keep their meaning (timeout, relay) |

- Wait matches exact names only (no wildcard) and several `--when` are ANDed; the catalog output is built around that.
- The read-only `events` commands print their output even when stdin is not a TTY (an agent in a background shell would otherwise get "output discarded" as with the other commands).

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
