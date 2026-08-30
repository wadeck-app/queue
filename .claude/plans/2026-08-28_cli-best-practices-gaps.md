# Gap remediation — queue-cli CLI best practices

Source: gap analysis against `~/.claude/docs/cli/`.

## CRITICAL

- [ ] **`queue cli self-check`** — updater uses `--version` as substitute which gives no real health signal. Implement `queue cli self-check` with typed checks: daemon client instantiable, config dir writable, bundle version present. Respect `CLI_SELF_CHECK_QUIET=1`.

## Base commands

- [ ] **Subcommand `--help`** — `queue dlq --help` falls through to unknown. Add `--help`/`-h` check on `rest[0]` for `dlq` group with `DLQ_GROUP_HELP` constant.
- [ ] **Exit codes in `--help`** — add table: 0=ok, 1=error, 2=daemon not running.
- [ ] **Env vars in `--help`** — document `QUEUE_CONFIG_DIR`.
- [ ] **`queue cli update`** — add manual foreground update following flow-cli pattern.
- [ ] **Human-readable `status`** — detect TTY and print formatted output; JSON only when `!isTTY || --json`.

## UX

- [ ] **`[ok]`/`[fail]` symbols** — add to status output and success confirmations (currently raw JSON or plain strings).
- [ ] **`queue cli logs` rename** — currently exposed as top-level `queue logs`; rename/alias to `queue cli logs [--follow]` for consistency with the `cli` subcommand group convention.
- [ ] **`queue cli logs --follow` stderr prefix** — `[queue] Following <path>` should go to stderr, not stdout.

## Config

- [ ] **`ConfigDir.migrateIfNeeded('queue')`** — not called anywhere in `main()`; add at top before command dispatch.

## Dev

- [ ] **`runCli(argv, deps)` injectable** — current `runQueueCommand` export still reads `process.argv`; refactor to accept `argv` and injectable `send`/`startDaemon` deps for proper unit testing.
- [ ] **`preversion` guard** — add to package.json scripts.
