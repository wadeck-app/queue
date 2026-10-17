# @wadeck-app/queue-cli

Local event-queue daemon and CLI — publish events, dispatch to subscribers, inspect the dead-letter queue.

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
| `wait ci [<sha>] [--workflow <name>] [--timeout <dur>] [--json]` | Block until the GitHub CI of a commit is done |
| `start` / `stop` | Start or stop the daemon manually |
| `logs [--follow]` | Tail daemon logs |
| `cli self-check` | Validate installation |
| `cli update` | Apply a pending update immediately |

The daemon auto-starts on any command that needs it; `queue start` is only needed to pre-warm it.

## Waiting for CI instead of polling

After `git push`, run `queue wait ci` (SHA defaults to `HEAD`, repository to the `origin` remote). An agent should launch it with `run_in_background`: it is re-invoked when the command exits.

It reads the history of relayed `on.github.workflow_run` events, so a CI that finished before the command started is answered at once. Requires the relay client (`queue relay start`).

"Done" means every workflow run seen for the commit is completed and nothing new happened for `--settle` (default 20s). With `--workflow <name>` (repeatable), only those workflows count.

| Exit code | Meaning |
|-----------|---------|
| 0 | All runs `success`, `skipped` or `neutral` |
| 1 | At least one run failed, was cancelled or timed out |
| 2 | `--timeout` (default 15m) reached |
| 3 | No run seen for the commit, or the relay client is not running |
| 4 | Invalid usage |

Exit 3 and 2 print the likely causes and `gh run list --commit <sha>` as a cross-check; GitHub does not redeliver lost webhooks.

## Configuration

Config dir: `~/.config/queue/` (override: `QUEUE_CONFIG_DIR` env)

## Update

Auto-updates in background on every invocation. Manual: `queue cli update`
