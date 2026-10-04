# Product Vision — queue

## Purpose

A local event-queue daemon and CLI for developer workflow automation. Projects publish named events; subscribers (CLI commands or HTTP calls) react to them, with configurable retries, backoff, and payload filtering.

## Architecture

```
queue push <event> <json>
  → QueueDaemon (singleton, port 47910)
      → ConfigLoader (global + project subscribers.yml)
      → PayloadFilter (when: expression filter)
      → SyncDispatcher (before* events — blocking, can abort)
      → AsyncDispatcher (on* events — WAL + retry)
          → HttpTransport | CliTransport
          → RetryScheduler (on failure)
          → DLQ (after all retries exhausted)
```

## Config model

- Global config: `~/.config/queue/subscribers.yml` (override: `QUEUE_CONFIG_DIR`)
- Project config: `.queue/subscribers.yml` (walked up from cwd, up to 20 levels)
- Project name: inferred from nearest `.queue` marker directory name
- Subscriber types: `cli` (shell command) or `http` (HTTP request)
- Conditional dispatch: `when:` field accepts a JSONPath/expression filter against the event payload

## Current state (as of 2026-08)

Implemented: push, retry, status, list-subscribers, dlq list/replay/clear, history, WAL persistence, DLQ, async/sync dispatch, HTTP/CLI transports, exponential/linear backoff, payload filtering, event pattern matching, idle self-shutdown.

Known gaps (from `.claude/plans/2026-08-28_cli-best-practices-gaps.md`):

| Priority | Gap |
|---|---|
| CRITICAL | `queue cli self-check` — currently uses `--version` as substitute, no real health checks |
| High | `queue dlq --help` falls through to unknown; add `--help` handling |
| High | Exit codes and `QUEUE_CONFIG_DIR` not documented in `--help` |
| High | `ConfigDir.migrateIfNeeded('queue')` not called in `main()` |
| High | `queue cli update` — manual foreground update not implemented |
| Medium | `runQueueCommand` still reads `process.argv` directly; needs injectable `argv`/deps for unit tests |

## Intended direction

- Close the CLI best-practices gaps above before adding new features
- `queue cli self-check` must perform typed health checks (daemon client instantiable, config dir writable, bundle version present) and respect `CLI_SELF_CHECK_QUIET=1`
- Human-readable `status` output (detect TTY; JSON only when `!isTTY || --json`)
- `queue logs` rename/alias to `queue cli logs` for consistency with the `cli` subcommand group
