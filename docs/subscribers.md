# Subscriber commands and `{{ }}` templating

A `cli` subscriber runs `command` when an event matches. The event envelope is always sent to the program on stdin as one JSON line.

## Two modes

| Command | Run | Payload values |
|---|---|---|
| No `{{ }}` | By the shell (`sh`, `cmd.exe`), exactly as written. `subscribers.yml` is trusted configuration. | Not available. |
| Holds `{{ }}` | **Without a shell**: split into arguments first, then each `{{ }}` is replaced inside its argument. | Always data: a value never splits into several arguments and never becomes code. |

Why: payloads come from outside (relay webhooks, `queue push`). Pasting them into a shell line is command injection.

## Placeholders

- `{{ field }}` and `{{ payload.field }}` read a **top-level** key of the payload (a key may contain dots; no nested paths).
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

Node cannot start a batch file without `cmd.exe`, and `queue`, `npm` and most shims are `.cmd`. The program is looked up like `cmd.exe` does (working directory, then `PATH`, with `PATHEXT`). If it is a `.cmd`/`.bat`, it runs as `cmd.exe /d /s /c` with every argument double-quoted, and every substituted value is checked first.

A value holding any of `& | < > ^ % ! "`, a backtick or a line break makes that delivery fail **permanently** (straight to the DLQ, no retries; the log and the DLQ entry say which field and character class). The literal parts of the template are not checked. Prefer a real program (`.exe`, or `node script.js`) when payloads are free text.

Other extensions found on `PATHEXT` (`.ps1`, `.js`, ...) cannot be started without a shell: use their interpreter.

## Caveats

- A value that starts with `-` is still an option for the program (`--help`). Write `--title={{ title }}` or use the program's `--` separator.
- A batch file that re-expands its own arguments unquoted in `if (...)` blocks is the batch author's responsibility.
- Threat model: [.claude/threat-model.md](../.claude/threat-model.md).
