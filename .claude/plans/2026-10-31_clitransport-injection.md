# CliTransport command injection fix

## Problem

`CliTransport.interpolateCommand` pastes payload values into the command, then runs it with `spawn(cmd, [], { shell: true })`. Payload data (relay events, `queue push`) can become shell code on POSIX and on Windows `cmd.exe`.

## Decision (D)

| # | Rule |
|---|---|
| 1 | Command without `{{ }}`: unchanged (shell, trusted config). |
| 2 | Command with `{{ }}`: no shell. Tokenize the template into argv first, then substitute inside each token. A value never splits and never becomes code. |
| 3 | Windows `.cmd`/`.bat` target (PATH + PATHEXT): run via `cmd.exe /d /s /c` with quoted args, after refusing substituted values containing `& \| < > ^ % ! " \`` or CR/LF. Refusal = permanent failure (straight to the DLQ, no retry). |
| 4 | Load-time guard (`ConfigLoader`, `queue sub add/edit`): `{{ }}` plus shell operators/expansions, an unterminated quote or a placeholder in the program position is rejected with the fix. |
| 5 | Object/array values: `JSON.stringify` as one argument. `undefined`/`null`/missing: empty string (unchanged). |

## Files

- `packages/queue-core/src/dispatch/commandTemplate.ts` (+ test): tokenizer, substitution, load-time check.
- `packages/queue-core/src/dispatch/CliTransport.ts` (+ test): argv spawn, `.cmd` path, `permanent` flag.
- `AsyncDispatcher`: `permanent` failure goes to the DLQ without retry.
- `ConfigLoader`, `queue sub add|edit`: guard.
- `docs/subscribers.md` (new), README link, `.claude/threat-model.md`.
