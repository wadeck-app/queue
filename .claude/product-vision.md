# Product Vision — queue

## Purpose

A local event-queue daemon and CLI for developer workflow automation. Programs and people publish named events; subscribers (a CLI command, an HTTP call or a built-in action) react to them, with retries, backoff and payload filtering. Agents wait for events instead of polling.

## Architecture

```
queue push / queue-sdk (push protocol 1.5.0)      queue-relay-client (own daemon, QUEUE_RELAY_PORT)
  -> QueueDaemon (singleton, QUEUE_DAEMON_PORT)     -> RelayConnection (WS to the remote webhook relay)
     (queue-core createQueueService)                -> RelayPlugin per source (plugin-github)
       -> ConfigLoader: global + project              -> client-side eventType / payloadMatch
          subscribers.yml, project registry           -> push into QueueDaemon (starts it on demand)
       -> PayloadFilter (`when`)
       -> SyncDispatcher   (before.* : blocking, can abort)
       -> AsyncDispatcher  (other events: WAL, retry, DLQ)
            -> transports: CliTransport | HttpTransport | ActionTransport (ActionPlugin: emit, agent-wake)
            -> RetryScheduler -> DLQ after the retries
       -> HistoryLog / EventLogger / EventCatalog -> `queue history|logs|events|wait`, dashboard
```

| Part | Role |
|---|---|
| `queue-core` | Config, dispatch, WAL (`wal.ndjson`), DLQ (`dlq.ndjson`, 1000 rows), history, logs, retention, event catalog, action registry; no CLI code |
| `queue-cli` | The `queue` command, the daemon and relay daemon entries, the bundle; registers built-in actions |
| `queue-sdk` | Zero-dependency client for other programs: finds/starts the daemon, never throws; push protocol with its own SemVer (`docs/push-protocol.md`) |
| `queue-relay-client`, `plugin-github` | Consume a webhook relay and turn deliveries into queue events; the client stays source-agnostic |
| `plugin-agent-wake` | The `agent-wake` action preset |
| `app-module-queue` | app-core dashboard module (pages, widgets, routes under `/api/modules/queue/`); see `CLAUDE.md` and `docs/project-integration.md` |

## Contracts that define the product

- `before.*` events are synchronous and can abort; others are asynchronous and WAL-tracked. See `guiding-principles.md`.
- Storage: WAL and DLQ are locked, rewritten files. `history/` (terse audit trail, replayable) keeps the last 91 calendar days and 200 MB; `logs/` (verbose per-dispatch trail) the last 91 days and 100 MB. See `threat-model.md`.
- Subscribers: `cli`, `http` or `action`, from `<config dir>/subscribers.yml` plus the `subscribers.yml` of the registered project and its parents; they accumulate. Defaults: 5 retries, exponential backoff, 30 s timeout. See `docs/subscribers.md`.
- The daemon starts on demand and stops after 60 s without pending work; the relay starts on demand for `queue wait ci`. See `guiding-principles.md`.
- Config dir: `--config` (launcher), `QUEUE_CONFIG_DIR`, `$XDG_CONFIG_HOME/queue`, `~/.config/queue`.
- Events are declared in a catalog and observed (`queue events`); `queue wait <event|pattern>` blocks until one is recorded (`docs/wait.md`).

## Known gaps

Facts only; the product boundary is in `out-of-scope.md`.

| Gap | Detail |
|---|---|
| No cross-push ordering, no deduplication | By design (`out-of-scope.md`) |
| The remote relay does not replay missed events to a connecting client | A wait only sees events that arrive while the relay is connected |
| `main()` in `QueueIndex.ts` reads `process.argv` directly | Exported command functions take injected deps, `main()` does not |
| Two copies of the `relay.yml` template in the CLI | `relayStart.ts` and `QueueIndex.ts` (webhook subcommands) |
| DLQ capped at 1000 rows | The oldest row is dropped with a warning |
| History/logs are pruned only when a new day file is created | Between two new days the directories can exceed their size limit; the Log files page runs the policy on demand |
