# queue-sdk troubleshooting

Every failure reaches `onError` as `{ kind, message, event, outcome }` (a declaration failure also has `operation: 'register-events'` and `event` is the source) and, unless `silent`, `console.warn` once per distinct problem until a push succeeds again. `outcome` is `dropped` (not recorded) or `unknown` (may be recorded). The token is never printed.

| `kind` | Cause | What to do |
|---|---|---|
| `not-installed` | `queue` is not on `PATH` and the daemon is stopped | Install `queue-cli` and check that `queue` runs in the same environment as your program |
| `start-failed` | `queue start` exited non-zero or could not run | Run `queue start` in a terminal to see why |
| `not-ready` | `queue start` succeeded but the daemon did not answer within 5 s, or kept refusing | Run `queue status` in a terminal |
| `corrupt-port-file` | `config.port` is not what the daemon writes | Delete it or run `queue start` |
| `no-token` | `health_token` is missing or empty | The daemon creates it on first start; if your queue uses another directory, set `QUEUE_CONFIG_DIR` or the `configDir` option |
| `unauthorized` | The token is still refused after one re-read | Another daemon (another config dir) answers on that port; check `configDir` |
| `incompatible` | The daemon's protocol version and the SDK's do not overlap | Update the package named in the message (`@wadeck-app/queue-sdk` or `queue-cli`) |
| `rejected` | The daemon refused the protocol version in the push | Same as `incompatible` |
| `unsupported` | `registerEvents` on a daemon older than push protocol 1.1.0 (from `GET /version`, or HTTP 404 to the command), or a push with a `project` on one older than 1.2.0 (the event is dropped). Pushes without a project still work | Update `queue-cli`, then restart the daemon (`queue stop`, `queue start`); the message names the daemon's protocol |
| `rejected-declaration` | The daemon refused the declaration of `registerEvents`; nothing was stored. `result.problems` lists `{ path, message }` | Fix each `path` (`events[3].name`) in the declaration; the rules are in "Declaring your events" of the reference |
| `aborted` | A `before*` subscriber refused the event, or `subscribers.yml` is invalid | Read the reason; fix `subscribers.yml` (`queue sub list` shows what loads) |
| `unknown-outcome` | The connection reset or timed out after sending (for `registerEvents`: twice, it is retried once) | Push: check `queue history` before sending again. Declaration: call `registerEvents` again, it replaces the previous one. Raise `timeoutMs` if the daemon is slow |
| `http-error`, `bad-answer`, `unexpected` | The daemon answered something unexpected | Report it with the full message |
| `not-serialisable` | The payload (or a declaration) cannot become JSON (BigInt, cycle, ...); the message names the path | Send plain data |
| `invalid-argument` | Empty event name or source, or a bad `timeoutMs` | Fix the call |
| `overflow` | More than `maxPending` pushes in flight | `await queue.flush()` between bursts, or raise `maxPending` |

## Nothing is sent and every result is `dropped` "switched off"

The publisher was created with `off: true`, or the environment variable `QUEUE_SDK_OFF=1` is set (the SDK announced it once when it was created). Unset the variable, or remove the option, wherever events must reach the queue.

## Events reach the queue but nothing runs

The push succeeded (`queued`) with `subscriberCount` 0: no subscriber matches the event name for this `cwd`. Names match by pattern (`*` one segment, `**` or `>` the rest). Check `queue sub list <event>` run from the same directory, and `queue history` for the "no subscribers configured" line.

## Seeing what the SDK does

Pass `onError` and `onWarning` and log them, or call `await queue.status()`: it tells whether the daemon is `running`, will be started with `queue start`, or cannot be reached, and why.
