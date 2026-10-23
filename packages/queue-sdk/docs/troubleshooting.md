# queue-sdk troubleshooting

Every failure reaches `onError` as `{ kind, message, event, outcome }` and, unless `silent`, `console.warn` once per distinct problem until a push succeeds again. `outcome` is `dropped` (not recorded) or `unknown` (may be recorded). The token is never printed.

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
| `aborted` | A `before*` subscriber refused the event, or `subscribers.yml` is invalid | Read the reason; fix `subscribers.yml` (`queue sub list` shows what loads) |
| `unknown-outcome` | The connection reset or timed out after sending | Check `queue history` before sending again; raise `timeoutMs` if the daemon is slow |
| `http-error`, `bad-answer`, `unexpected` | The daemon answered something unexpected | Report it with the full message |
| `not-serialisable` | The payload cannot become JSON (BigInt, cycle, ...) | Send plain data |
| `invalid-argument` | Empty event name, or a bad `timeoutMs` | Fix the call |
| `overflow` | More than `maxPending` pushes in flight | `await queue.flush()` between bursts, or raise `maxPending` |

## Events reach the queue but nothing runs

The push succeeded (`queued`) with `subscriberCount` 0: no subscriber matches the event name for this `cwd`. Names match by pattern (`*` one segment, `**` or `>` the rest). Check `queue sub list <event>` run from the same directory, and `queue history` for the "no subscribers configured" line.

## Seeing what the SDK does

Pass `onError` and `onWarning` and log them, or call `await queue.status()`: it tells whether the daemon is `running`, will be started with `queue start`, or cannot be reached, and why.
