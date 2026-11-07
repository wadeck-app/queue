# Subscriber commands and `{{ }}` templating

A `cli` subscriber runs `command` when an event matches. The event envelope is always sent to the program on stdin as one JSON line.

## Two modes

| Command | Run | Payload values |
|---|---|---|
| No `{{ }}` | By the shell (`sh`, `cmd.exe`), exactly as written. `subscribers.yml` is trusted configuration. | Not available. |
| Holds `{{ }}` | **Without a shell**: split into arguments first, then each `{{ }}` is replaced inside its argument. | Always data: a value never splits into several arguments and never becomes code. |

Why: payloads come from outside (relay webhooks, `queue push`). Pasting them into a shell line is command injection.

## Placeholders

- `{{ field }}` and `{{ payload.field }}` read the payload by path, same rule for `cli` and action templates:
  1. an **own key** named exactly like the whole dotted path wins (`{"a.b": "x", "a": {"b": "y"}}` gives `x` for `{{ a.b }}`);
  2. otherwise the path is walked through own properties, one segment per dot (`{{ a.b }}` against `{"a": {"b": 1}}` gives `1`). Before this rule it rendered empty.
  A dotted key below level one is not tried (`{"a": {"b.c": 1}}` is not reachable). Array elements are reached by index (`{{ list.0 }}`); `length` and methods are not.
- `__proto__`, `constructor` and `prototype` are never read from a payload: a placeholder with such a segment is refused at load time (`cli` and action).
- `cli` only: the `payload.` prefix is stripped once, so `{{ payload.a }}` and `{{ a }}` are the same field. For a payload key that is itself named `payload`, write `{{ payload.payload.a }}`.
- Missing, `null` or non-object payload: empty string (the argument stays, empty).
- String, number, boolean: its text. Object or array: one JSON argument.
- Replaced inside quotes too, single quotes included.
- The program (first word) must be literal.

## Quoting rules (templates with `{{ }}`)

- Whitespace separates arguments.
- `'...'` and `"..."` group; `""` is an empty argument; adjacent pieces join (`--msg="a b"c` is one argument).
- `\"` is a literal `"` (outside single quotes). Any other backslash is literal, so `C:\dir\tool.exe` works unquoted.
- A path ending in a backslash inside double quotes needs single quotes: `'C:\dir\'`.
- An unterminated quote is an error.
- No `$VAR`, `%VAR%`, `~`, globs, pipes or redirections: there is no shell.

## Rejected when the config is loaded

A command with `{{ }}` is refused (daemon push, `queue list-subscribers`, `queue sub add|edit`) when it holds, outside quotes, `|`, `&`, `;`, `>` or `<`, or, outside single quotes, a backtick, `$(`, `$VAR`, `${` or `%VAR%`; or an unterminated quote; or a placeholder as the program; or a placeholder inside the code of a shell or interpreter (below). The error names the subscriber and the file.

Fix: read the envelope on stdin and put the shell logic in a script, or remove the shell syntax. Put a literal `|` in single quotes if it is an argument.

```yaml
# before: the payload is pasted into a shell line
- { name: triage, type: cli, command: "flow run triage.yml --input id={{ payload.id }} | tee out.log" }
# after: no shell; the script reads the envelope from stdin if it needs more
- { name: triage, type: cli, command: "node run-triage.js --input id={{ payload.id }}" }
```

### A shell or interpreter that runs a placeholder as code

Re-introducing a shell (`bash -c 'echo {{ x }}'`) puts the value back into code text, so it is refused at load time too. Refused: a placeholder inside the code argument of a known shell or interpreter.

| Program | Code argument |
|---|---|
| `sh bash zsh dash ksh mksh ash fish csh tcsh` | the argument after `-c` (also `-lc`, `-ec`, ... and `--command`) |
| `cmd` | `/c`, `/k`, `/r` and everything after (cmd joins them into one command line) |
| `powershell`, `pwsh` | every argument, unless `-File` is given |
| `node`, `bun` | after `-e`, `-p`, `--eval`, `--print` (or inside `--eval=...`) |
| `deno` | after `eval` |
| `python`, `perl`, `ruby`, `php`, `lua`, `Rscript`, `osascript` | after `-c` / `-e` / `-r` |

Programs are matched by name only (path, `.exe`, `.cmd`, `.bat` ignored; case-insensitive on Windows). A placeholder in a **separate argument after** the code stays allowed:

```yaml
# refused: the value is part of the shell script
- { name: n, type: cli, command: "bash -c 'echo {{ x }}'" }
# accepted: the value is the positional parameter $1
- { name: n, type: cli, command: "bash -c 'echo \"$1\"' _ {{ x }}" }
- { name: n, type: cli, command: "node -e \"console.log(process.argv[1])\" {{ x }}" }
- { name: n, type: cli, command: "pwsh -NoProfile -File script.ps1 {{ x }}" }
```

`cmd.exe` has no safe form: use a real program or a script that reads the envelope on stdin.

Best-effort denylist, not a proof. Not detected: wrappers (`env`, `sudo`, `xargs`, `ssh`, `docker exec`, `wsl`, `find -exec`), other code-taking programs (`awk`, `sed`, `jq`, ...), a shell started on a script path taken from a placeholder (`bash {{ x }}`), and an interpreter renamed or wrapped in a script. `subscribers.yml` stays trusted configuration; the list is in `commandTemplate.ts` (`INTERPRETER_RULES`).

## No shell: built-ins and aliases are unavailable

With `{{ }}`, the program is started directly. `cmd.exe` built-ins (`echo`, `dir`, `copy`, `type`, `set`, ...), shell functions and aliases do not exist unless an executable of that name is on `PATH` (e.g. Git's `echo.exe`).

On Windows a missing program is a **permanent** failure (DLQ on the first attempt, no retries):

```
subscriber 'NAME': program 'echo' was not found (searched the working directory and PATH with the extensions of PATHEXT). Fix: install it, put it on PATH, or give its full path in the command.
```

On Linux/macOS the spawn error is reported instead (`spawn NAME ENOENT (subscriber 'NAME': the program was not found. Fix: install it, put it on PATH, or check the working directory '...')`) and the delivery is retried.

Alternatives: call the real executable (`"C:\Program Files\Git\usr\bin\echo.exe" {{ x }}`), or run a script that reads the envelope on stdin (`node script.js`).

## Windows `.cmd` and `.bat` targets

Node cannot start a batch file without `cmd.exe`, and `queue`, `npm`, `flow`, `task` and most global tools are npm-generated `.cmd` shims. The program is looked up like `cmd.exe` does (working directory, then `PATH`, with `PATHEXT`).

| Found file | Started as | Values |
|---|---|---|
| Standard npm shim (`.cmd` that only runs `node <script>.js %*`) | `node.exe script.js args...` directly, no `cmd.exe` | Any character, including `"`, `&`, `%`, `^`, `!`; one inert argument each |
| Any other `.cmd`/`.bat` | `cmd.exe /d /s /c`, every argument double-quoted | Checked first, see below |

A shim is recognised only when every line is one of the standard npm/cmd-shim lines and the script is an existing `.js`/`.cjs`/`.mjs` file under the shim's own directory. Anything else (extra commands, extra arguments, environment changes, a path with `..`, a drive letter or `%`, a shim over 8 KB) is not a shim. Node is `node.exe` next to the shim, else the first `node.exe` on `PATH` (not the working directory); if neither exists the delivery fails permanently with how to fix it.

For any other batch file, a value holding any of `& | < > ^ % ! "`, a backtick or a line break makes that delivery fail **permanently** (straight to the DLQ, no retries; the log and the DLQ entry say which field and character class, and that the file is not a recognised npm shim). The literal parts of the template are not checked. Fix: point the command at a real program (`.exe`, or `node script.js`) or at the tool's npm shim.

Other extensions found on `PATHEXT` (`.ps1`, `.js`, ...) cannot be started without a shell: use their interpreter.

## Filters (`when:`)

The filter is evaluated on the whole envelope (`event`, `payload`, `meta`, ...). Two forms:

| Form | Rule |
|---|---|
| `path=value` | Dotted path, split at the FIRST `=`; equality only (a number compares as a number). One comparison, no "or", no "and". `payload.newStatus=done` |
| JSONPath starting with `$` | Matches when the first result is truthy. Use `@root` to reach the envelope from inside a filter: `$[?(@root.payload.projectId=='64f4ae91' && (@root.payload.event=='onTaskCreated' \|\| @root.payload.event=='onStatusChange'))]` |

A filter such as `$.payload[?(@.projectId=='x')]` filters the children of `payload`, not the payload itself: it does not do what it looks like. A filter that does not match is logged with why (`queue logs`). A `when:` filter never loads a `queue.dlq.*` base event: it sees the reference (see below).

## Caveats

- A value that starts with `-` is still an option for the program (`--help`). Write `--title={{ title }}` or use the program's `--` separator.
- A batch file that re-expands its own arguments unquoted in `if (...)` blocks is the batch author's responsibility.
- Threat model: [.claude/threat-model.md](../.claude/threat-model.md).

## What is logged of a `cli` run

Each dispatch record in `~/.config/queue/logs/<day>.ndjson` (shown by `queue logs`) carries `exitCode` and the last 1024 characters of stdout and stderr (`stdoutTail`, `stderrTail`), on success too. Empty streams are omitted and control characters other than newline and tab are removed. `queue logs` shows them in full for a failure and as a one-line `output:` preview (200 characters) for a success. The stdin envelope is never logged, and none of this is written to the history. Output can hold secrets: see Log retention below.

**Log retention.** `logs/` keeps each day file (`<day>.ndjson` and the launcher's `<day>-launcher.log`) 90 days at most, by the date in its name, and 100 MB in total. The daemon checks when it creates a new day's file (not on every write): it deletes files older than 90 days, then whole days oldest first while the total is over 100 MB. Today's files are never deleted; if they alone exceed 100 MB the daemon logs a warning. A file it cannot delete (open elsewhere on Windows) is reported in the log with how to fix it. Other files in `logs/` are never touched. `history/` (`<day>.ndjson`, what `queue replay` and the dashboard read) follows the same rule with 90 days and 200 MB, deleting whole days oldest first; its reports are logged as `HistoryRetention` diagnostics in `logs/`. The dashboard's Log files page lists both directories (size, day, what the policy would delete) and offers "Prune by policy", which runs this same policy now, and deletion of a single day file; it refuses today's file, a future day and a file modified in the last minute. Days are UTC, except the launcher's, which use the machine's local day. Each action writes one `LogFilesPage` line in the day log.

## Action subscribers

`type: action` runs a plugin inside the daemon instead of a command or an HTTP call. Available actions: `emit` (pushes any event) and `agent-wake` (wakes a Claude Code session). An unknown name lists the available ones.

```yaml
subscribers:
  on.github.check_run:
    - type: action
      name: wake-owner
      action: agent-wake
      when: payload.check_run.conclusion=failure
      with:
        to: "project:my-app"
        text: "CI failed on {{ payload.check_run.name }}"
        mode: passive
```

CLI: `queue sub add <event> --name <n> --type action --action <name> --set key=value ...` (repeatable; split on the first `=`; a dotted key nests, `--set payload.text=hi`; values are text).

### Fields

- `with` is the plugin's settings; the plugin validates it when the file loads, with no silent stripping. A `with` the plugin refuses fails that subscriber alone, for good, to the DLQ with the plugin's message (like an unknown action); `queue sub add|edit` refuse it up front. A missing `action` or a forbidden field still aborts the whole file.
- `command`, `url`, `method`, `headers`, `cwd` and `env` are refused on an action. `timeout`, `retries`, `backoff` and `when` apply.
- `emit`: `with.event` is a literal concrete event name (no placeholder, no wildcard); `with.payload` is a mapping whose string values are templates.
- `agent-wake` always emits `agent.message { to, text, from, mode, ref }`:

| Field | Rule |
|---|---|
| `to` | Required. A session id (UUID) or `project:` + 1-200 characters, no control characters or line breaks (spaces, parentheses, accents allowed). A placeholder is allowed; the rendered value is checked again. |
| `text` | Required, at most 16 KB once rendered, not empty. |
| `from` | Default `queue:{{ event }}`; one line, at most 200 characters. |
| `mode` | `wake` (default) or `passive`; literal only. |
| `ref` | Default `{{ id }}`; at most 200 characters. |

### Templates in `with` values

Rendered in Node, never in a shell, in one pass. Differences with `cli`:

| | `cli` | action |
|---|---|---|
| Payload field | `{{ title }}` or `{{ payload.title }}` | `{{ payload.title }}` |
| Nested field | `{{ a.b }}` or `{{ payload.a.b }}` | `{{ payload.a.b }}` (an own key `a.b` first, then own properties; see Placeholders) |
| Envelope | n/a | `{{ event }}`, `{{ id }}`, `{{ timestamp }}`, `{{ payload }}` (whole payload as JSON) |
| Bare `{{ x }}` | payload field | **load-time error**: write `payload.x` |
| Shell metacharacters | refused | allowed (no shell) |

Objects render as JSON; a NUL character refuses the delivery; each rendered field is capped at 64 KB. A render or validation failure after substitution is permanent: straight to the DLQ on the first attempt, with a message naming the field (never the value).

YAML pitfall: an unquoted `text: {{ payload.x }}` parses as a flow mapping. Always quote: `text: "{{ payload.x }}"`.

### The `queue.dlq.added` and `queue.dlq.removed` events

The daemon emits them itself, **always**: with or without a subscriber on them (the history records both), and only when a subscriber on `queue.dlq.added` or `>` exists do they run anything. Filed under the project and directory of the failed delivery, default direction. Subscribe to `queue.dlq.added` to be told when a delivery is given up, e.g. to label a task.

| Field | `added` | `removed` | Meaning |
|---|---|---|---|
| `entryId` | yes | yes | Id of the DLQ entry (the `--id` of `queue dlq replay|clear`) |
| `eventId` | yes | yes | First-push id of the base event; absent for an entry written before events were tracked by id |
| `event`, `subscriberId` | yes | yes | Base event name and the subscriber that failed |
| `projectId` | if any | if any | Project of the delivery |
| `reason` | yes | yes | `added`: `retries-exhausted`, `permanent-failure`, `invalid-configuration`, `given-up`. `removed`: `replayed`, `cleared`, `evicted` |
| `error` | yes | no | Last error, cut at 500 characters |
| `attempts` | yes | no | Attempts made |
| `exitCode`, `target` | if known | no | Exit code of a cli command that ran to its end; command, URL or `action:<name>` |
| `original` | yes | yes | `{ "$eventRef": "<eventId>" }` (`null` without `eventId`), see below |

Rules:

- `removed` is emitted when an entry leaves the DLQ: `replayed` once the replay dispatch has started, `cleared` per entry of a clear (after it returned, 10 at a time), `evicted` when the 1000-entry cap drops the oldest.
- A replay that fails again gives `removed` then `added`, both with the same `entryId`.
- Emitted once per entry in the DLQ, at-least-once: the daemon checks the row is not there yet, emits `added`, then writes the row. A crash between the emit and the write leaves the WAL entry `failed` (the startup rescan only reschedules `pending` ones), so running it again (`queue retry --event <walId>`) emits a second `added` for the same `entryId`: a duplicate, never a loss. A row that already exists emits nothing. The one exception is `removed(evicted)`, which follows the write that evicts (a crash in between loses it).
- No event about an entry whose base event is a `queue.` event: a subscriber failing on `queue.dlq.added` is visible in the DLQ and the history, and produces no further event.
- Loop guard: the event carries `hops + 1` of the failed delivery and `causedBy` it. At the hop cap (5) it is not emitted and the daemon log says so, naming the entry.
- A replay whose subscriber was renamed or whose configuration does not load emits `removed(replayed)` but dispatches nothing: the log says the WAL entry stays pending. With a configuration that does not load, the event itself cannot be recorded; the log says that too.
- Dashboard paths (clear, give-up of one or all stuck events) write the files without the daemon, then ask it to announce the change through the `dlq-notify` RPC: `added` with `reason: given-up`, `removed` with `cleared` (or `evicted` when a give-up pushed the oldest row out at the cap). The daemon builds the event itself, so every rule above applies. If it is not running (it is not started for this) or refuses, the operation still stands and the dashboard message says the `queue.dlq.*` event could not be sent and why; no subscriber was told. `queue dlq clear|replay` run inside the daemon and emit once.
- The events page shows `queue.dlq.*` with their example but no test-push button: the `queue.` namespace cannot be pushed.

Getting the base payload: `{{ payload.original.<field> }}` in a template, or `queue history --event-id <eventId> --json` by hand. A subscriber on `>` sees only the reference.

### Lazy references in `queue.dlq.*` events

The events the daemon emits about the dead-letter queue (`queue.dlq.added`, `queue.dlq.removed`) carry no copy of the failed event's payload. They carry a reference to it, `"original": { "$eventRef": "<eventId>" }`, and a template placeholder that walks into `original` reads the payload of that base event, loaded from the history only when a placeholder needs it (once per delivery): `{{ payload.original.taskId }}` is the `taskId` of the base event.

- Followed only for an event the daemon built (`meta.origin`, never settable from a push), named exactly `queue.dlq.added` or `queue.dlq.removed`, at the top-level key `original`, one level deep. Anywhere else `{"$eventRef": ...}` is plain data, so a pushed payload cannot read another event.
- Only the payload of the base event is readable, never its metadata. A reference inside that payload is not followed.
- Templates only (`cli` arguments and action `with` values). `when:` filters, http bodies and the envelope on stdin show the reference, not the base payload.
- A terminal `{{ payload.original }}` renders the reference JSON as it is, without loading anything.
- Base event gone (the history keeps at most 90 days and 200 MB) or reference `null` (a dead-letter entry written before events were tracked by id): permanent failure naming the field and the reference, never a payload value. Fix: read what you need before then, or run `queue history --event-id <id> --json` by hand.
- An unreadable history is a plain failure and is retried.
- `queue.` names are reserved: no push, `emit` action or `register-events` can produce them (see [push-protocol.md](push-protocol.md#reserved-namespace)).

### Delivery and idempotence

- Delivery is at-least-once: a retry, `queue dlq replay` or a daemon restart can emit the same message again.
- `{{ id }}` renders the id of the first push (`meta.eventId`), not the per-attempt WAL id, so it is stable across retries and replays. `agent-wake` defaults `ref` to it: the consumer ignores a `ref` it has seen.
- `{{ timestamp }}` is the timestamp of the attempt's envelope; do not use it as a key.

### Where the emitted event goes

- Filed under the project (and working directory) of the event the action received; for a `to-children` descendant, that descendant's project. It is pushed with the default direction.
- `queue wait` filters by event name and time, not by project.
- The trigger record of an emitted event in the history carries `causedBy: { eventId, subscriberId }` (the source event's first-push id and the action subscriber); `queue history` shows `caused by <subscriberId>`. It is set by the daemon only, never read from a push.

### Loop guards

- Runtime: each emitted event carries a hop counter (set by the daemon only, never read from the wire); an action whose source is already at 5 hops is refused, permanently.
- Static: `queue sub add|edit` refuses a change that closes a cycle of actions with no `when:`, and warns when a `when:` may break it. The daemon logs the same findings at start and never aborts. Only the real delivery chain counts: the global file and the emitter's project and its ancestors, not descendants.
- An action cannot emit an event starting with `before` (permanent failure).
- `queue replay` goes through the push RPC and resets the counter to 0.

### `before*` events

An action on a `before*` pattern only passes through: it never answers the pusher (its stdout is empty) and its result is not a verdict.

### Compatibility and upgrades

- A daemon without action support rejects the whole file (`aborted` with the reason): update the daemon first.
- The registry is built at daemon start: after installing a new action plugin, restart the daemon (`queue stop`, then any command) before it is known. Until then the subscriber fails alone, to the DLQ, with the list of available actions.
- `agent-wake` declares `agent.message` in the event catalog (source `action-agent-wake`) at each daemon start.
