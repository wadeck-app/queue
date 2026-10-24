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
| `push <event> <json> [--timeout <dur>]` | Publish an event |
| `retry --event <id>` | Re-enqueue a failed event |
| `status [--json]` | Show daemon and queue status |
| `list-subscribers [event] [--json]` | List registered subscribers |
| `dlq list` | List dead-letter entries |
| `dlq replay --id <id>` | Replay a dead-letter entry |
| `dlq clear [--id <id>]` | Clear dead-letter entries (all or one) |
| `wait <event> [--when <expr>] [--since <d>]` | Block until a queue event is recorded |
| `wait ci [<sha>] [--workflow <name>] [--timeout <dur>] [--json]` | Block until the GitHub CI of a commit is done |
| `events list [--source S] [--prefix P] [--match PAT] [--declared-only] [--terminal] [--json]` | List the declared events and what was seen |
| `events show <name> [--json]` | Schema, example, `--when` paths and a ready `wait` command |
| `events register --source S --file <events.json>` | Declare the events of a non-Node program |
| `start` / `stop` | Start or stop the daemon manually |
| `logs [--follow]` | Tail daemon logs |
| `cli self-check` | Validate installation |
| `cli update` | Apply a pending update immediately |

The daemon auto-starts on any command that needs it; `queue start` is only needed to pre-warm it.

## Waiting instead of polling

`queue wait <event>` and `queue wait ci` block until an event or a commit's CI is done, so an agent does not poll. An agent finds the event names and payload paths with `queue events list|show` (output kept even without a TTY); an undeclared name still waits but warns, `--strict` refuses it (exit 4). See [docs/wait.md](docs/wait.md).

## Pushing events from your own program

Use [`@wadeck-app/queue-sdk`](packages/queue-sdk/README.md): it finds and starts the daemon, never throws and reports every failure. The wire contract and its versioning rules are in [docs/push-protocol.md](docs/push-protocol.md).

## Configuration and updates

Config dir: `~/.config/queue/` (override: `QUEUE_CONFIG_DIR` env)
Auto-updates in background on every invocation. Manual: `queue cli update`
