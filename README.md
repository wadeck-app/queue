# @wadeck-app/queue-cli

Local event-queue daemon and CLI - publish events, dispatch to subscribers, inspect the dead-letter queue.

## Install

```
npm install -g @wadeck-app/queue-cli
```

## Usage

```
queue <command> [options]
```

| Command | Description |
|---------|-------------|
| `push <event> <json> [--project <p>] [--direction to-parents\|to-children] [--timeout <dur>]` | Publish an event |
| `retry --event <id>` | Re-enqueue a failed event |
| `replay <eventId> [--cwd <dir>]` | Resubmit a past event's payload as a new event tagged `replayOf` (manual testing) |
| `history [--event <name>] [--subscriber <id>] [--project <p>] [--status success\|failed\|dlq\|filtered] [--since <-Nd\|-Nh\|-Nm>] [--limit\|-n <N>] [--offset <N>] [--follow\|-f] [--json]` | List past events and how each subscriber ended |
| `history --event-id <id> [--json]` | Show one entry (payload and outcomes) by its eventId; exit 1 when the history no longer holds it |
| `status [--json]` | Show daemon and queue status |
| `list-subscribers [event] [--json]` | List registered subscribers |
| `dlq list` | List dead-letter entries |
| `dlq replay --id <id>` | Replay a dead-letter entry |
| `dlq clear [--id <id>]` | Clear one entry, or the whole DLQ without `--id` (the count is printed); `--id` without a value or an unknown id exits 1 |
| `wait <event> [--when <expr>] [--since <d>] [--name <who>.<what>]` | Block until a queue event is recorded |
| `wait ci [<sha>] [--workflow <name>] [--timeout <dur>] [--name <who>.<what>] [--json]` | Block until the GitHub CI of a commit is done |
| `waiters [--history [--since <d>] [--name <glob>] [--outcome <o>] [--limit N]] [--json]` | Who is waiting now (`queue push` counts them), or who waited, from when to when and how it ended |
| `events list [--source S] [--prefix P] [--match PAT] [--declared-only] [--terminal] [--json]` | List the declared events and what was seen |
| `events show <name> [--json]` | Schema, example, `--when` paths and a ready `wait` command |
| `events register --source S --file <events.json>` | Declare the events of a non-Node program |
| `sub list\|add\|remove\|edit ...` | Manage `subscribers.yml` entries (`cli`, `http`, `action`); `queue sub --help` |
| `relay start\|stop\|status [--json]` | Webhook relay client (`relay.yml`); `relay webhook list\|history` query the remote relay |
| `start` / `stop` | Start or stop the daemon manually |
| `logs [--follow]` | Tail daemon logs (`cli logs` is the same) |
| `cli self-check` | Validate installation |
| `cli update` | Apply a pending update immediately |

The daemon auto-starts on any command that needs it; `queue start` is only needed to pre-warm it. `QUEUE_PROJECT` is the default project of `push`; `history`, `status` and `dlq list` are global views and filter on an explicit `--project` only.

## Waiting instead of polling

`queue wait <event>` and `queue wait ci` block until an event or a commit's CI is done, so an agent does not poll. An agent finds the event names and payload paths with `queue events list|show` (output kept even without a TTY); an undeclared name still waits but warns, `--strict` refuses it (exit 4). `<event>` may be a quoted pattern (`queue wait "dep.published.*"`; `*` one segment, `>` the rest; always double-quote, unquoted `>` is a shell redirect). Name each wait with `--name <who>.<what>` (an unnamed one is `anon.<pid>` and warns; a name will become mandatory): `queue push` then says `1 waiting: <name>` and `queue waiters` lists it. See [docs/wait.md](docs/wait.md).

## Subscribers

A `cli` subscriber command may template payload values with `{{ payload.field }}`; such a command runs without a shell. Rules, load-time errors and Windows `.cmd` limits: [docs/subscribers.md](docs/subscribers.md).

## Pushing events from your own program

Use [`@wadeck-app/queue-sdk`](packages/queue-sdk/README.md): it finds and starts the daemon, never throws and reports every failure. The wire contract and its versioning rules are in [docs/push-protocol.md](docs/push-protocol.md).

## Configuration and updates

Config dir: `QUEUE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/queue`, else `~/.config/queue/`. The Go launcher and the Node side resolve it the same way (the launcher also accepts `--config <dir>`, which wins over the variable); the launcher template is `packages/queue-cli/ci/launcher-main.go.tmpl`.

Ports: the queue daemon asks for `QUEUE_DAEMON_PORT` (default 47910), the relay daemon for `QUEUE_RELAY_PORT` (default 47911); integer 1024-65535, anything else makes the daemon and `queue start` / `queue relay start` exit 1 naming the variable and the value. If the port is taken the daemon takes the next free one (up to +10). Commands never use these variables to locate a daemon: they read `config.port` of their own config dir, so an isolated `QUEUE_CONFIG_DIR` finds its own daemon. `queue status` and `queue relay status` show the port in use. `queue start` on a running daemon warns when `QUEUE_DAEMON_PORT` differs from the real port.

Auto-updates in background on every invocation. Manual: `queue cli update`
