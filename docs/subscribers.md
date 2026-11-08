# Subscriber commands and `{{ }}` templating

A `cli` subscriber runs `command` when an event matches. The event envelope is always sent to the program on stdin as one JSON line.

## Two modes

| Command | Run | Payload values |
|---|---|---|
| No `{{ }}` | By the shell (`sh`, `cmd.exe`), exactly as written. `subscribers.yml` is trusted configuration. | Not available. |
| Holds `{{ }}` | **Without a shell**: split into arguments first, then each `{{ }}` is replaced inside its argument. | One argument per placeholder, never split, never shell code. What the started program does with it is not guaranteed: see "A shell or interpreter" and "Option injection". |

Why: payloads come from outside (relay webhooks, `queue push`). Pasting them into a shell line is command injection.

Guaranteed: no shell, and a value cannot split into several arguments. Best-effort: the load-time refusal of programs that run an argument as code or read it as an option (a denylist of known names, below). A value can still become code through a program the denylist does not know.

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

Re-introducing a shell (`bash -c 'echo {{ x }}'`) puts the value back into code text, so a placeholder is refused at load time where a known program would read it as code, as an option or as the script to run. Programs are matched by name only (directory, `.exe`, `.cmd`, `.bat` and a trailing version such as `node18`, `perl5.36`, `lua5.4`, `bash-5` ignored; case-insensitive on every platform, because Windows and macOS file systems are).

| Program | Refused |
|---|---|
| `sh bash zsh dash ksh mksh ash fish csh tcsh` | the flag token and the argument after `-c` (also bundled `-lc`, `-ec`, attached `-cecho`, and `--command`) |
| `cmd`, `mshta` | **any** placeholder, in any position (cmd reads `/c`, `/k`, `/r` anywhere and joins all arguments into one command line; mshta runs its argument as a document or script) |
| `powershell`, `pwsh` | any placeholder unless the command is `[switches] -File <literal script> ...` (see below) |
| `node`, `nodejs`, `tsx`, `ts-node`, `bun` | `-e`, `-p`, `--eval`, `--print` (or inside `--eval=...`) |
| `deno` | `eval` |
| `awk` (`gawk`, `mawk`, `nawk`) | `-f`/`-e`/`--file`/`--source` and the argument after it; the first non-option argument is the awk program |
| `wscript`, `cscript` | the first argument that does not start with `//` is the script |
| `env`, `busybox` | a placeholder where the program (`env`) or the applet (`busybox`) is read, or in `env -S`; otherwise the program behind them is checked with its own rule (`env bash -c ...`, `busybox sh -c ...`) |
| `python`, `perl`, `ruby`, `php`, `lua`, `Rscript`, `osascript` | `-c` (python, also `-m`), `-e`/`-E` (perl, ruby, lua, Rscript, osascript), `-r` (php); attached or bundled forms count (`-cprint(1)`, `-eputs`, `-lne`, `-Bc`): the flag token and the argument after it |
| `npm install\|i\|add` (and abbreviations), `bun add\|install`, `pnpm add\|install`, `yarn add` | **any** placeholder after the subcommand (every argument names a package to install) |
| `npm init\|create\|run`, `pnpm exec\|dlx\|create\|run`, `yarn exec\|dlx\|create\|run`, `bun create`, `deno x\|install` | a placeholder as the first argument after the subcommand (the package, template or script name) |
| all of the above, `npx`, `bunx`, `pnpx`, `npm exec`, `npm x`, `pnpm`, `yarn`, `bun run`, `deno run` | a placeholder **before the first literal script**: inside an option (`--require={{ x }}`), as the value of an option (`node -r {{ x }}`, `npx -p {{ x }} tool`), or as the script, module or package itself (`bash {{ x }}`, `python -m {{ x }}`, `deno run {{ x }}`, `npx {{ x }}`) |

PowerShell runs its first argument that is not a switch as command text, wherever `-File` shows up later. A placeholder is therefore accepted only when everything before `-File` is `-NoProfile`, `-NoLogo`, `-NonInteractive`, `-NoExit`, `-ExecutionPolicy <value>` or `-WindowStyle <value>` (case-insensitive, unique prefixes accepted), `-File` (or `-f`, `-fi`, `-fil`) is followed by a literal script path, and the placeholder comes after that path. `-Command`, `-EncodedCommand`, a command word, an unknown switch or a placeholder in the script path are refused.

A placeholder in a **separate argument after** a literal script, or after the code of a code flag, is accepted:

```yaml
# refused: the value is part of the shell script
- { name: n, type: cli, command: "bash -c 'echo {{ x }}'" }
# refused: attached code is still code
- { name: n, type: cli, command: "python \"-cprint('{{ x }}')\"" }
# refused: first positional argument is the PowerShell command text
- { name: n, type: cli, command: "powershell {{ x }} -File script.ps1" }
# refused: the value would choose the script
- { name: n, type: cli, command: "node {{ x }}" }
# accepted: the value is the positional parameter $1
- { name: n, type: cli, command: "bash -c 'echo \"$1\"' _ {{ x }}" }
- { name: n, type: cli, command: "node -e \"console.log(process.argv[1])\" {{ x }}" }
- { name: n, type: cli, command: "node script.js --id {{ x }}" }
- { name: n, type: cli, command: "pwsh -NoProfile -File script.ps1 {{ x }}" }
```

`cmd.exe` has no safe form: use a real program or a script that reads the envelope on stdin.

For `npm`, `npx`, `pnpm` and `yarn` the position of the package is computed with a closed list of the options that take a value (taken from the config definitions of npm 11). An option the list does not know, followed by a placeholder, is refused with a message naming it (write it `--name=value`, or name the package before the placeholder); an option written `--name=value` needs no entry. The `+x` options of POSIX shells (`bash +x {{ x }}`) count as options like `-x`.

Best-effort denylist, not a proof. **Not detected**:

- wrappers that start another program with the value, other than `env` and `busybox` (which are followed): `sudo`, `xargs`, `ssh`, `docker exec`, `wsl`, `find -exec`, `nohup`, `time`, `timeout`, `nice`, `start`, `Start-Process`, `yarn workspace`;
- programs whose argument is itself a program: `sed`, `jq`, `make`, `git -c`, `curl --config`, `psql -c`, ...;
- `deno run` on a URL or a script found through the value, and any interpreter renamed, copied or wrapped in a script;
- an option of an interpreter other than npm, npx, pnpm and yarn that takes a value and is missing from the list in `commandTemplate.ts` (`INTERPRETER_RULES`): its value is taken for the script, so a later placeholder is judged as if after the script (for npm, npx, pnpm and yarn an unknown option is refused instead);
- a `NAME=value` that `env` sets and that changes what the program does (`env NODE_OPTIONS={{ x }} node script.js`, `LD_PRELOAD`): the value is data for the check;
- a program with an option of its own that starts with `/` (Windows tools): only `cmd` and `mshta` are refused outright, and `looksLikeOption` in `CliTransport.ts` does not treat `/x` as an option, because that would refuse every absolute POSIX path.

`subscribers.yml` stays trusted configuration.

## Option injection

A placeholder that is the **whole argument** (`{{ x }}`, `"{{ x }}"`, `{{ a }}{{ b }}`) lets the value start the argument. When the rendered value starts with `-` followed by a letter or another `-` (`-rf`, `--help`, `--`), or with `@` (many tools read the file that follows), the delivery fails **permanently** (DLQ, no retries) with the field, the reason (the program would read it as an option) and the fix. A negative number (`-5`) and a lone `-` are data. Fix: write the option name in front, so the value cannot start the argument, or validate the field at the source:

```yaml
# refused when title is "--help"
- { name: n, type: cli, command: "tool {{ payload.title }}" }
# accepted: the value stays attached to the option
- { name: n, type: cli, command: "tool --title={{ payload.title }}" }
```

A placeholder inside a larger argument (`--title={{ x }}`) is not affected. The check cannot know whether the program reads `--` as the end of its options, so it applies whatever the program.

## No shell: built-ins and aliases are unavailable

With `{{ }}`, the program is started directly. `cmd.exe` built-ins (`echo`, `dir`, `copy`, `type`, `set`, ...), shell functions and aliases do not exist unless an executable of that name is on `PATH` (e.g. Git's `echo.exe`).

On Windows a missing program is a **permanent** failure (DLQ on the first attempt, no retries):

```
subscriber 'NAME': program 'echo' was not found on the PATH of the queue daemon (57 PATH entries, tried with the extensions of PATHEXT; the working directory is not searched, ...). The daemon keeps the PATH it was started with; the list is in "queue logs" ... Fix: install it, put it on PATH, or give its full path in the command ...
```

The error carries only the number of PATH entries, not the directories (it reaches the DLQ and the `queue.dlq.added` event that other subscribers see). The full list is logged once when the daemon starts: `queue logs`.

A bare program name is looked up on `PATH` only, never in the working directory, and a relative `PATH` entry (`.`, `bin`) is ignored for the same reason (the not-found error counts the ignored entries): the working directory of a subscriber is often a cloned project, and a `tool.cmd` planted there must not run in place of the real tool (`cmd.exe` would). A program written with a directory (`./tool.cmd`, `sub\tool`, `C:\x\tool.exe`) is resolved as written, relative to the working directory.

On Linux/macOS the spawn error is reported instead (`spawn NAME ENOENT (subscriber 'NAME': the program was not found. Fix: install it, put it on PATH, or check the working directory '...')`) and the delivery is retried.

Alternatives: call the real executable (`"C:\Program Files\Git\usr\bin\echo.exe" {{ x }}`), or run a script that reads the envelope on stdin (`node script.js`).

## Windows `.cmd` and `.bat` targets

Node cannot start a batch file without `cmd.exe`, and `queue`, `npm`, `flow`, `task` and most global tools are npm-generated `.cmd` shims. A bare program name is looked up on `PATH` with `PATHEXT` (not in the working directory, unlike `cmd.exe`); a name written with a directory is resolved relative to the working directory.

| Found file | Started as | Values |
|---|---|---|
| Standard npm shim (`.cmd` that only runs `node <script>.js %*`) | `node.exe script.js args...` directly, no `cmd.exe` | Any character, including `"`, `&`, `%`, `^`, `!`; one inert argument each |
| Any other `.cmd`/`.bat` | `cmd.exe /d /s /c`, every argument double-quoted | Checked first, see below |

A shim is recognised only when every line is one of the standard npm/cmd-shim lines and the script is an existing `.js`/`.cjs`/`.mjs` file under the shim's own directory. Anything else (extra commands, extra arguments, environment changes, a path with `..`, a drive letter or `%`, a shim over 8 KB) is not a shim. Node is `node.exe` next to the shim, else the first `node.exe` on `PATH` (not the working directory); if neither exists the delivery fails permanently with how to fix it.

For any other batch file, a value holding any of `& | < > ^ % ! "`, a backtick or a line break makes that delivery fail **permanently** (straight to the DLQ, no retries; the log and the DLQ entry say which field and character class, and that the file is not a recognised npm shim). A value **ending with a backslash** (`C:\dir\`) fails the same way: cmd.exe cannot pass it faithfully (a batch file reading `%~1` wants it raw, a program parsing `%*` like the C runtime wants it doubled, so it is refused rather than corrupted one way or the other). `C:\dir` and inner backslashes arrive exactly; an npm shim (run through node directly) is not affected. The literal parts of the template are not checked. Fix: point the command at a real program (`.exe`, or `node script.js`) or at the tool's npm shim.

Other extensions found on `PATHEXT` (`.ps1`, `.js`, ...) cannot be started without a shell: use their interpreter.

## Filters (`when:`)

The filter is evaluated on the whole envelope (`event`, `payload`, `meta`, ...). Two forms:

| Form | Rule |
|---|---|
| `path=value` | Dotted path, split at the FIRST `=`; equality only (a number compares as a number). One comparison, no "or", no "and". `payload.newStatus=done` |
| JSONPath starting with `$` | Matches when the first result is truthy. Use `@root` to reach the envelope from inside a filter: `$[?(@root.payload.projectId=='64f4ae91' && (@root.payload.event=='onTaskCreated' \|\| @root.payload.event=='onStatusChange'))]` |

A filter such as `$.payload[?(@.projectId=='x')]` filters the children of `payload`, not the payload itself: it does not do what it looks like. A filter that does not match is logged with why (`queue logs`). A `when:` filter never loads a `queue.dlq.*` base event: it sees the reference (see below).

## Retries, timeout and backoff

| Field | Default | Meaning |
|---|---|---|
| `retries` | 5 | Total tries of an `on*` delivery (the first one included); `0` gives up after the first failure. A permanent failure is never retried |
| `timeout` | 30s | Per try. For a `before*` event the timeout of the push is one budget for the whole event (see [push-protocol.md](push-protocol.md)) |
| `backoff` | `exponential` | Wait before the next try, from the number of failed tries `n`: `exponential` 1, 2, 4, 8 then 16 minutes; `linear` `n + 1` minutes, at most 16 |

- The retry is an `orch` job (`orch add --once`) that runs `queue retry --event <walId>`. When `orch` is missing or refuses, the entry becomes `failed` and its `lastError` says why and how to run it by hand; the daemon log says it once per cause.
- `queue retry` of an entry whose delivery is running is refused: one delivery at a time per entry.
- An in-flight entry is "stuck" (`give-up-stuck`, the dashboard) 2 hours after the later of its creation and the time its next retry was due, so a long retry plan is not given up early.

## Caveats

- A value that is the whole argument and starts like an option is refused (see "Option injection").
- A batch file receives each accepted value exactly in `%~1`. A value ending with a backslash is refused for it (see "Windows `.cmd` and `.bat` targets").
- A timeout stops the whole process tree (`taskkill /T /F` on Windows, the process group elsewhere), and a program that exited is no longer waited on for more than 3 s because a child it left behind keeps its output pipes open.
- The output of a `cli` subscriber is kept in memory up to its first 1 MiB and its last 64 KiB per stream; the middle is dropped and replaced by `[output truncated: N bytes dropped, ...]`.
- An `http` subscriber's timeout covers the response body too, a body over 1 MiB fails the delivery (`HTTP <status>: response body is larger than the limit of 1 MiB`), and a redirect (3xx) is never followed: it fails with `HTTP 302: redirect to <origin> not followed` (origin only, no path, query or header), so custom headers and the event are never sent to another address. Fix: set `url` to the final address.
- A batch file that re-expands its own arguments unquoted in `if (...)` blocks is the batch author's responsibility.
- A `name` is unique per event key of a file; the same name under two keys (`on.a` and `*`) is allowed. The subscriberId of each holder is then `<name>@<event key>` (`notify@on.a`, `notify@*`), so each has its own WAL entry, DLQ row and retry target; a name used once keeps its plain id. Renaming a key or making a name unique changes the id: a WAL or DLQ entry written under the old id reports "no longer exists" on retry or replay (give it up or clear it).
- Threat model: [.claude/threat-model.md](../.claude/threat-model.md).

## Editing with `queue sub`

- **Event keys** follow the rules of `queue wait`: `*` is a whole segment, `>` the remaining ones and last, no empty segment. `dep.pub*`, `on.*x`, `on..x`, `on.>.x` are refused by the loader (error names the file and key), `queue sub add` and `queue events list --match` (exit 4).
- **Nothing is dropped**: the file is edited as parsed YAML, so unknown subscriber keys (`notes`, a typo like `timout`) and the form of each event (array, or `{cwd, env, commands}`) are written back as found. `add`, `edit`, `remove` and `list` warn `[warn] ... unknown key 'timout' (did you mean 'timeout'?)`; the daemon still ignores such a key.
- **Comments and values**: a new event is appended as text (the file is otherwise byte for byte unchanged, when `subscribers:` is a block mapping). Any other `add`/`edit`/`remove` is made in place with the [`yaml`](https://eemeli.org/yaml/) Document API: comments, anchors and the written text of every value the command did not change (`2024-01-01`, `0x1F`, `0755`, a 20-digit integer, quotes, block scalars), also in unknown keys and `with:`, stay as written. Layout is normalized: indentation becomes 2 spaces, blank-line runs collapse to one, a comment after `key:` moves to the line below, a new key goes at the end of its mapping, comments of a removed subscriber go with it. The result is re-read with the loader and must equal the edited document; if it does not (e.g. removing a field that comes from a `<<` merge key), nothing is written and the error names `--rewrite`, which writes the whole file again (comments and layout lost, said in a `[warn]`). A symlinked `subscribers.yml` is written through the link; one whose target cannot be resolved is refused. `queue sub add __proto__` is refused (reserved name).
- **`edit` merges**: only the given flags change; `--header` and `--set` merge per key. `--unset <field>` (repeatable) removes `timeout, retries, backoff, when, method, command, url, action, cwd, headers, env, with` or one key (`headers.<name>`, `env.<name>`, `with.<key>`). `--type` to another type clears the old type's fields (command; url, method, headers; action, with; cwd and env when going to action), says which, and needs the new type's companion (`--url`, `--command`, `--action`).
- **Flags are strict**: a flag without its value, a repeated single-value flag, an unknown option (with a suggestion), a stray word, `--retries` that is not a whole number, `--method` outside POST, PUT, PATCH, DELETE (the event is a JSON body, so not GET) are errors and nothing is written.
- **`queue sub list`**: on a terminal, a "Waiting now" section follows when a `queue wait` is running (not a subscriber: not in `--json`, not with `--scope`; see [wait.md](wait.md)). Ids are the daemon's (`<project id>/<name>` for a project file, `<name>@<event>` for a repeated name) with or without `--scope`. A subscriber that cannot run gets a `[warn]` line (exit 0) and a `problem` field in `--json`. The dashboard Subscribers page shows `problem` too, but only what the files reveal; action problems need the plugins of the CLI (the module cannot depend on queue-cli).
## What is logged of a `cli` run

Each dispatch record in `~/.config/queue/logs/<day>.ndjson` (shown by `queue logs`) carries `exitCode` and the last 1024 characters of stdout and stderr (`stdoutTail`, `stderrTail`), on success too. Empty streams are omitted and control characters other than newline and tab are removed. `queue logs` shows them in full for a failure and as a one-line `output:` preview (200 characters) for a success. The stdin envelope is never logged, and none of this is written to the history. Output can hold secrets: see Log retention below.

**Log retention.** `logs/` keeps each day file (`<day>.ndjson` and the launcher's `<day>-launcher.log`) for the last 91 calendar days (today and the 90 before), by the date in its name, and 100 MB in total. The daemon checks when it creates a new day's file (not on every write): it deletes files older than that, then whole days oldest first while the total is over 100 MB. Today's files are never deleted; if they alone exceed 100 MB the daemon logs a warning. Two guards against a wrong clock: the age is counted from at most 2 days after the newest file (a forward clock jump or a long idle never ages the directory out; the log gets a warning with the gap), and one run never deletes by age more than half of the files when that is more than 10 files (it deletes none and warns; delete by hand or from the dashboard page). A directory or link named like a day file is reported and ignored. A file it cannot delete (open elsewhere on Windows) is reported in the log with how to fix it. Other files in `logs/` are never touched. `history/` (`<day>.ndjson`, what `queue replay` and the dashboard read) follows the same rule with 90 days and 200 MB, deleting whole days oldest first; its reports are logged as `HistoryRetention` diagnostics in `logs/`. The dashboard's Log files page lists both directories (size, day, what the policy would delete) and offers "Prune by policy", which runs this same policy now, and deletion of a single day file; it refuses today's file (for a launcher log also the local today and tomorrow), a future day, and a file modified in the last minute (24 hours for a launcher log) or with a modification time in the future. Days are UTC, except the launcher's, which use the machine's local day. Each action writes one `LogFilesPage` line in the day log.

**Damaged queue files.** A `history/` line that is not valid JSON (a write cut short by a crash) is skipped and every other line is read; `queue history` prints a `[warn]` naming the file, the count and the first line, and the dashboard route answers a `warnings` field. A `wal.ndjson` or `dlq.ndjson` line that is not valid JSON is copied to `wal.ndjson.corrupt` / `dlq.ndjson.corrupt` (0600) before the next rewrite drops it, and the daemon logs a `Wal` / `DlqStore` warning in `queue logs`. A full DLQ (1000 rows) drops its oldest row and logs a warning naming it.

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

- `with` is the plugin's settings; the plugin validates it when the file loads, with no silent stripping. A `with` the plugin refuses, or a plugin whose `validate` throws, fails that subscriber alone, for good, to the DLQ with the plugin's message (like an unknown action); `queue sub add|edit` refuse it up front. Every such problem is written once per daemon run to the daemon log (`queue logs`, "cannot run") at start and at the first load, and `list-subscribers` carries it in a `problem` field. A missing `action` or a forbidden field still aborts the whole file.
- `command`, `url`, `method`, `headers`, `cwd` and `env` are refused on an action. `timeout`, `retries`, `backoff` and `when` apply.
- `emit`: `with.event` is a literal concrete event name (no placeholder, no wildcard); `with.payload` is a mapping whose string values are templates.
- `agent-wake` always emits `agent.message { to, text, from, mode, ref }`:

| Field | Rule |
|---|---|
| `to` | Required. A session id (UUID) or `project:` + 1-200 characters, no control characters or line breaks (spaces, parentheses, accents allowed). A placeholder is allowed; the rendered value is checked again. |
| `text` | Required, at most 16 KB once rendered, not empty. |
| `from` | Default `queue:{{ event }}`; one line, at most 200 characters. |
| `mode` | `wake` (default) or `passive`; literal only. |
| `ref` | Default `{{ id }}`; at most 200 characters. Dedupe semantics: see Delivery and idempotence. |

### Templates in `with` values

Rendered in Node, never in a shell, in one pass. Differences with `cli`:

| | `cli` | action |
|---|---|---|
| Payload field | `{{ title }}` or `{{ payload.title }}` | `{{ payload.title }}` |
| Nested field | `{{ a.b }}` or `{{ payload.a.b }}` | `{{ payload.a.b }}` (an own key `a.b` first, then own properties; see Placeholders) |
| Envelope | n/a | `{{ event }}`, `{{ id }}`, `{{ timestamp }}`, `{{ subscriber }}` (id of the subscriber being run), `{{ payload }}` (whole payload as JSON) |
| Bare `{{ x }}` | payload field | **load-time error**: write `payload.x` |
| Shell metacharacters | refused | allowed (no shell) |

Objects render as JSON; a NUL character refuses the delivery; each rendered field is capped at 64 KB. A render or validation failure after substitution is permanent: straight to the DLQ on the first attempt, with a message naming the field (never the value).

YAML pitfall: an unquoted `text: {{ payload.x }}` parses as a flow mapping. Always quote: `text: "{{ payload.x }}"`.

### The `queue.dlq.added` and `queue.dlq.removed` events

The daemon emits them itself, for every entry that enters or leaves the DLQ except the cases listed under "Rules" (a `queue.*` base event, the hop cap; see also "Never lost" below): with or without a subscriber on them (the history records both), and only when a subscriber on `queue.dlq.added` or `>` exists do they run anything. Filed under the project and directory of the failed delivery, default direction. Subscribe to `queue.dlq.added` to be told when a delivery is given up, e.g. to label a task.

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
- Never lost, at-least-once: `added` is emitted before the DLQ row is written. If the emit does not succeed (invalid `subscribers.yml`, refused push) the row is still written with `announce: pending`; the daemon emits it again at its start and after the next successful push, then clears the mark. A crash between the emit and the write can give a duplicate event, never none. Not guaranteed: an event for a base event named `queue.*` (excluded), the hop cap (row marked `announce: skipped`, never retried, the log names the entry), a row whose project is not registered any more (marked `announce: unannounceable` with an `announceReason`, never retried, still replayable and clearable), a `removed` whose daemon crashed before emitting, and a give-up/clear done while the daemon is down.
- A delivery still running when a give-up claims its entry does not overwrite it: its late result (ack, failure, move) is dropped and the daemon log says so (`no longer in flight`), so the entry stays in the DLQ once, never acked and replayable at the same time. Replaying it delivers again: check the target first.
- A replay whose subscriber was renamed or whose configuration does not load is refused: the daemon answers an error that says what to fix, and the entry stays in the DLQ (nothing is removed, no `removed` event).
- Dashboard paths (clear, give-up of one or all stuck events) go through the daemon when it runs: the dashboard sends `dlq-clear`, `give-up {id}` or `give-up-stuck`, and the daemon does the operation and builds the events from the rows it moved or removed (`given-up`, `cleared`, `evicted` when a give-up pushed the oldest row out at the cap). A client supplies no event data, so nothing can forge one. If the daemon is not running (it is not started for this), the dashboard does the operation on the files and its message says the `queue.dlq.*` event could not be sent; no subscriber was told. `queue dlq clear|replay` run inside the daemon and emit once.
- The events page shows `queue.dlq.*` with their example but no test-push button: the `queue.` namespace cannot be pushed.

Getting the base payload: `{{ payload.original.<field> }}` in a template, or `queue history --event-id <eventId> --json` by hand. A subscriber on `>` sees only the reference.

### Lazy references in `queue.dlq.*` events

The events the daemon emits about the dead-letter queue (`queue.dlq.added`, `queue.dlq.removed`) carry no copy of the failed event's payload. They carry a reference to it, `"original": { "$eventRef": "<eventId>" }`, and a template placeholder that walks into `original` reads the payload of that base event, loaded from the history only when a placeholder needs it (once per delivery): `{{ payload.original.taskId }}` is the `taskId` of the base event.

- Followed only for an event the daemon built (`meta.origin`, never settable from a push), named exactly `queue.dlq.added` or `queue.dlq.removed`, at the top-level key `original`, one level deep. Anywhere else `{"$eventRef": ...}` is plain data, so a pushed payload cannot read another event.
- Only the payload of the base event is readable, never its metadata. A reference inside that payload is not followed.
- Templates only (`cli` arguments and action `with` values). `when:` filters, http bodies and the envelope on stdin show the reference, not the base payload.
- A terminal `{{ payload.original }}` renders the reference JSON as it is, without loading anything.
- Base event gone (the history keeps the last 91 calendar days, today and the 90 days before, and 200 MB) or reference `null` (a dead-letter entry written before events were tracked by id): permanent failure naming the field and the reference, never a payload value. Fix: read what you need before then, or run `queue history --event-id <id> --json` by hand.
- An unreadable history is a plain failure and is retried.
- `queue.` names are reserved: no push, `emit` action or `register-events` can produce them (see [push-protocol.md](push-protocol.md#reserved-namespace)).

### Delivery and idempotence

- Delivery is at-least-once: a retry, `queue dlq replay` or a daemon restart can emit the same message again.
- `{{ id }}` renders the id of the first push (`meta.eventId`), not the WAL id: the same across the retries and `queue dlq replay` of a delivery, and the same for every subscriber of that push. `queue replay` is a new push and gets a new id.
- `agent-wake` defaults `ref` to `{{ id }}`, and a consumer that dedupes on `ref` drops a `ref` it has seen. Two `agent-wake` subscribers on one event that message the same session therefore collide: the second message is dropped. Fix: `ref: "{{ id }}:{{ subscriber }}"`.
- `{{ subscriber }}` is the subscriber id: its `name`, prefixed `<project id>/` in a project file, and `@<event key>` when the name is used under several event keys of the file.
- `{{ timestamp }}` is the timestamp of the attempt's envelope; do not use it as a key.

### Where the emitted event goes

- Filed under the project (and working directory) of the event the action received; for a `to-children` descendant, that descendant's project. It is pushed with the default direction.
- `queue wait` filters by event name and time, not by project.
- The trigger record of an emitted event in the history carries `causedBy: { eventId, subscriberId }` (the source event's first-push id and the action subscriber); `queue history` shows `caused by <subscriberId>`. It is set by the daemon only, never read from a push.

### Loop guards

- Runtime depth: each emitted event carries a hop counter (set by the daemon only, never read from the wire); an action whose source is already at 5 hops is refused, permanently.
- Runtime width: the hop cap does not bound fan-out (3 emitters of their own event gave 364 events). Each chain also has an emission budget of 100 events (`MAX_ACTION_EMISSIONS_PER_ROOT`), counted per root event (the first push; the root id is carried by the daemon, never read from the wire). The emission past it is refused, permanently (DLQ, first attempt), and the daemon log says it once per root, naming the root event, the subscriber and the cap. The counters live in memory (forgotten after 1 hour or beyond 10 000 roots), so a restart resets them.
- Not covered: a `cli` subscriber that runs `queue push` starts a new root at hop 0 (the counter cannot be passed through the wire), so neither the hop cap, nor the budget, nor the static check sees that loop. Keep such a command out of a chain that can reach itself.
- Static: `queue sub add|edit` refuses a change that closes a cycle of actions with no `when:`, and warns when a `when:` may break it. The daemon logs the same findings at start and never aborts. Only the real delivery chain counts: an action fires for the events of its project and of its descendants, and what it emits reaches the global file and the files of the project of that event and its ancestors. A `to-children` subscriber cannot close a loop (emitted events never travel downwards).
- An action cannot emit an event starting with `before` (permanent failure).
- `queue replay` goes through the push RPC and resets the counter to 0.

### `before*` events

An action on a `before*` pattern only passes through: it never answers the pusher (its stdout is empty) and its result is not a verdict.

### Superseded runs

A run that times out keeps going (it cannot be cancelled) but its context is dead: `context.signal` is aborted, a later `push` is refused (`superseded: ...`, logged) and `resolveRef` throws, so the retry is the only run that emits. The same holds for a push made after the plugin returned. A timeout shorter than 1 s is printed in milliseconds.

### Compatibility and upgrades

- A daemon without action support rejects the whole file (`aborted` with the reason): update the daemon first.
- The registry is built at daemon start: after installing a new action plugin, restart the daemon (`queue stop`, then any command) before it is known. Until then the subscriber fails alone, to the DLQ, with the list of available actions.
- `agent-wake` declares `agent.message` in the event catalog (source `action-agent-wake`) at each daemon start.
