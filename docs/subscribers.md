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

A command with `{{ }}` is refused (daemon push, `queue list-subscribers`, `queue sub add|edit`) when it holds, outside quotes, `|`, `&`, `;`, `>` or `<`, or, outside single quotes, a backtick, `$(`, `$VAR`, `${` or `%VAR%`; or an unterminated quote; or a placeholder as the program. The error names the subscriber and the file.

Fix: read the envelope on stdin and put the shell logic in a script, or remove the shell syntax. Put a literal `|` in single quotes if it is an argument.

```yaml
# before: the payload is pasted into a shell line
- { name: triage, type: cli, command: "flow run triage.yml --input id={{ payload.id }} | tee out.log" }
# after: no shell; the script reads the envelope from stdin if it needs more
- { name: triage, type: cli, command: "node run-triage.js --input id={{ payload.id }}" }
```

## Windows `.cmd` and `.bat` targets

Node cannot start a batch file without `cmd.exe`, and `queue`, `npm` and most shims are `.cmd`. The program is looked up like `cmd.exe` does (working directory, then `PATH`, with `PATHEXT`). If it is a `.cmd`/`.bat`, it runs as `cmd.exe /d /s /c` with every argument double-quoted, and every substituted value is checked first.

A value holding any of `& | < > ^ % ! "`, a backtick or a line break makes that delivery fail **permanently** (straight to the DLQ, no retries; the log and the DLQ entry say which field and character class). The literal parts of the template are not checked. Prefer a real program (`.exe`, or `node script.js`) when payloads are free text.

Other extensions found on `PATHEXT` (`.ps1`, `.js`, ...) cannot be started without a shell: use their interpreter.

## Caveats

- A value that starts with `-` is still an option for the program (`--help`). Write `--title={{ title }}` or use the program's `--` separator.
- A batch file that re-expands its own arguments unquoted in `if (...)` blocks is the batch author's responsibility.
- Threat model: [.claude/threat-model.md](../.claude/threat-model.md).
