# Threat Model — queue

## Scope

Local event-queue daemon on a single developer machine. No network exposure beyond localhost. Subscribers execute CLI commands or call HTTP endpoints as configured by the user.

## Assets

| Asset | Sensitivity | Notes |
|---|---|---|
| `subscribers.yml` (global + project) | High — defines which commands run on which events | Shell command injection if modified by attacker |
| `wal.ndjson` | Medium — in-flight event payloads including any secrets passed in JSON | Stored in `QUEUE_CONFIG_DIR` |
| `dlq.ndjson` | Medium — failed event payloads; may contain sensitive data | Same as WAL |
| `logs/` | Low–Medium — subscriber execution output | May contain secrets printed by subscribers |
| `history/` | Medium — every trigger record stores the push payload verbatim (for `queue replay`), same sensitivity as WAL/DLQ | Bounded by `HistoryLog`'s retention (the last 91 calendar days and 200 MB in total, checked when a new day's file is created), unlike WAL (acked entries pruned after 24 h; a `dlq`-status entry is removed when its DLQ row is cleared or evicted, and orphans older than a day are pruned at daemon start) or DLQ (bounded via `maxSize` eviction) |
| Daemon port (47910) | Medium — a local process holding the bearer token (`health_token`) can send RPC commands | Localhost only + bearer token (mode 0600 file) |
| `_secrets_/.env.local` (`QUEUE_CONFIG_DIR`) | High — holds `QUEUE_RELAY_TOKEN`, the relay Consumer token (high-entropy bearer credential for the remote webhook relay) | Gitignored `_secrets_/` folder, protected from agents by the w-guardrails plugin; the daemon reads it, nothing prints it (errors name the path, never the value). Also accepted: env `QUEUE_RELAY_TOKEN`. A `.env.local` outside `_secrets_/` is a hard error. |
| `relay.yml` (`QUEUE_CONFIG_DIR`) | Medium — relay URL, plugins and subscriptions. A `token:` entry is still accepted but deprecated (plaintext, `relay start` warns) | Same filesystem trust boundary as `subscribers.yml` |

## Threats and mitigations

### Arbitrary command execution via subscriber config

- **Threat:** If `subscribers.yml` is writable by an attacker, they can register arbitrary shell commands that execute on the next matching event.
- **Mitigation:** OS-level file permissions on `~/.config/queue/` and `.queue/`. The tool does not add its own access controls.
- **Risk accepted:** Single-user local tool; file system is the trust boundary.

### Event payload injection into CLI commands

- **Threat:** A `cli` subscriber may template event payload values (`{{ payload.x }}`, data from relay events or `queue push`) into its command. Audited: `CliTransport` used to paste the value into the command and run it with `spawn(command, [], { shell: true })`, so a value like `a; touch x` or `& calc` ran as code on POSIX and on Windows `cmd.exe`. Environment variables are no fix on `cmd.exe` (`%X%` is re-parsed).
- **Mitigation:** A command with `{{ }}` runs without a shell: it is split into arguments first, then values are substituted inside each argument (`commandTemplate.ts`), so a value is always one argument. A standard npm-generated `.cmd` shim is run directly as `node.exe script.js args` (`NpmShim.ts`, strict whitelist of its lines, script inside its directory), so its values stay inert. Any other Windows `.cmd`/`.bat` target (which needs `cmd.exe`) refuses, as a permanent failure, any value holding `& | < > ^ % ! "`, a backtick or a line break, or ending with a backslash (cmd.exe cannot pass it faithfully: %~1 and a C-runtime %* disagree). At load time (`ConfigLoader`, `queue sub add|edit`) a command that mixes `{{ }}` with shell syntax, an unterminated quote or a placeholder as the program is rejected. See [docs/subscribers.md](../docs/subscribers.md).
- **Unchanged:** a command without `{{ }}` still runs in a shell as written (trusted `subscribers.yml`, see the first threat).
- **Guaranteed:** no shell and one argument per placeholder, whatever the value holds. **Best-effort, not guaranteed:** the load-time refusal of a placeholder that a known program would read as code, as an option or as the script (`INTERPRETER_RULES`: shells, cmd, PowerShell only as `-File <literal script> ...`, node/bun/deno, python, perl, ruby, php, lua, Rscript, osascript, npx/npm exec, matched by lowercase name, attached and bundled flags included).
- **Option injection:** a placeholder that is the whole argument and renders as `-x`, `--x` or `@...` is refused permanently (negative numbers pass); `--name={{ x }}` is the safe form.
- **Resolution (Windows):** a bare program name is looked up on `PATH` only, so a `tool.cmd` planted in the (often cloned) working directory does not run in place of the tool; a program written with a directory is resolved relative to the working directory. The not-found error carries only the count of PATH entries (it reaches the DLQ and `queue.dlq.added`); the list is in the daemon start log.
- **Timeout:** the whole process tree is stopped, and a grandchild holding the pipes cannot keep a dispatch (and the daemon) busy more than 3 s after the program exited.
- **Residual risk (not detected):** wrappers that start another program with the value (`env`, `sudo`, `xargs`, `ssh`, `docker exec`, `find -exec`), programs that take a program as argument (`awk`, `sed`, `jq`, ...), `deno run` on a URL, a renamed or script-wrapped interpreter, an interpreter option missing from the list; a batch file that re-expands its own arguments unsafely.

### Local process calling daemon RPC (port 47910)

- **Threat:** A local process that can reach the daemon port could push arbitrary events, trigger retries, or replay DLQ entries.
- **Mitigation:** The commands (every POST), `/quit` and `/health` require the bearer token of the `health_token` file in the config directory (created with mode 0600; `/version` does not). Reaching the port is not enough: the process must read that file.
- **Risk accepted:** a process that can read the config directory (same OS user) can read the token, and already has write access to `subscribers.yml` and the config files directly. On Windows the file mode is not enforced; the user profile ACL is the boundary. Single-user local tool.

### Sensitive data in WAL / DLQ

- **Threat:** Event payloads passed via `queue push <event> <json>` are written verbatim to `wal.ndjson` and `dlq.ndjson`. If payloads contain secrets (API keys, passwords), they persist on disk.
- **Mitigation:** No mitigation in the tool. Callers must not pass sensitive values as event payloads.
- **Risk accepted:** Caller responsibility; documented in usage.

### Sensitive data in history/ (queue replay payload storage)

- **Threat:** Since `queue replay <eventId>` needs the original payload, `HistoryLog.logTrigger` persists it verbatim in `history/<date>.ndjson`, readable in full via `queue history --json`. Same payload-contains-secrets risk as WAL/DLQ above, but history has no per-entry clearing (WAL clears on ack, DLQ evicts past `maxSize`) -- without a bound, it would retain every payload forever.
- **Mitigation:** `history/` files (`<day>.ndjson`) are kept for the last 91 calendar days (today and the 90 before; date in the name) and 200 MB in total (`LogRetention`, shared with `logs/`). The age is counted from at most 2 days after the newest file, and a run that would delete by age more than half of the files (and more than 10) deletes none and warns: a forward clock jump cannot wipe the history. The check runs when a new day's file is created, not on every write: older files go first, then whole days oldest first (`queue replay` needs whole days); today's file is never deleted (a single day over 200 MB only logs a warning). A file that cannot be deleted is logged and retried on the next new day. Between two new days, history can exceed 200 MB; the Log files page can run the same policy on demand.
- **Risk accepted:** Within the retention window, caller responsibility not to push secrets as payloads (same as WAL/DLQ).
- **Dashboard exposure:** The app-core module's `GET /api/modules/queue/history` also returns each payload as `payloadText` (indented JSON, capped at 20,000 characters; it replaces the raw `payload` in the list, the full one is on `GET /history/<eventId>` (app-core >= 2026.10.17-023) and in `queue history --json`), rendered in the Queue History page's expandable rows. Same sensitivity as `queue history --json`, but reachable by anything that can call app-core's HTTP API (localhost); do not expose app-core beyond localhost without authentication. The same holds for `GET /log-files` (file names, sizes, dates; the logs directory path) and for the deletion routes below.

### Sensitive data in logs/ (cli output tails)

- **Threat:** `AsyncDispatcher` writes the exit code and the last 1024 characters of a `cli` subscriber's stdout and stderr (`stdoutTail`, `stderrTail`) to `logs/<date>.ndjson`, on success and failure. Whatever the program prints, including secrets, lands there and in `queue logs` and the dashboard Logs page.
- **Mitigation:** Cap of 1024 characters per stream (the end is kept); control characters other than `\n` and `\t` are stripped; empty streams are not written; the stdin envelope is never logged; nothing of this goes to `history/`.
- **Retention:** `logs/` files (`<day>.ndjson`, and the launcher's `<day>-launcher.log`, pruned by the daemon) are kept for the last 91 calendar days (date in the name) and 100 MB in total (`LogRetention`, with the same clock-jump and mass-delete guards as `history/`; a directory named like a log file is reported, never deleted; a file with a modification time in the future is protected). The check runs when a new day's file is created, not on every write: older files go first, then whole days oldest first; today's files are never deleted (a single day over 100 MB only logs a warning). A file that cannot be deleted is logged and retried on the next new day. The Log files page runs the same policy on demand and can delete one day file (see "Dashboard routes that delete log files").
- **Risk accepted:** No redaction: a secret printed by a subscriber stays up to 91 days. A subscriber must not print secrets.

### Dashboard routes that would change what runs

- **Threat:** An HTTP route of the app-core module that writes `subscribers.yml` (`queue sub add|edit|remove`) lets any web page the user visits, or any local process, register an arbitrary command that runs on the next matching event. A browser can reach `localhost` routes; the daemon's raw RPC port it cannot.
- **Decision:** The module has no such route and no route that starts or stops a daemon. `GET /subscribers` masks the values of `headers` and `env` (tokens) and keeps their names. The mutating routes are `push`, `replay`, `retry`, `dlq/:id/replay` and `dlq/:id/clear`, which run or drop what is already configured (the log-file deletions are covered below).
- **Revisit only with:** an authentication / CSRF protection that app-core provides to every module.

### Dashboard routes that delete log files

- **Threat:** `POST log-files/:kind/prune` and `POST log-files/:kind/:day/:variant/delete` delete files. A web page the user visits, or a local process, can call them. A body-less POST is a "simple" cross-site request a browser sends without a preflight, so requiring a JSON body is not a protection.
- **Mitigation:** The client names a file by `kind` (logs|history), `day` (a real calendar date, round-trip checked) and `variant` (daemon|launcher), never a path; the name is built server-side from a fixed pattern and checked to stay inside the directory, and must be a regular file. Today (UTC), future days, the launcher's local today and tomorrow, and any file modified in the last minute (24 h for launcher files) are refused with 409. `wal.ndjson`, `dlq.ndjson` and `subscribers.yml` have no route. Unreadable WAL/DLQ lines are kept in `wal.ndjson.corrupt` / `dlq.ndjson.corrupt` (0600, same sensitivity as the files they come from), not deleted. The prune recomputes the plan at execution time.
- **CSRF statement:** The module has no guard of its own. app-core's server-wide request guard (minimum app-core `21f5150`, `app-core-cli` 2026.11.7-166-a969517b) answers 403 `cross-site-request` to any non-GET/HEAD/OPTIONS under `/api/` with a foreign `Origin` or `Sec-Fetch-Site: cross-site|same-site`, and 403 `host-not-allowed` to a `Host` that is not 127.0.0.1, localhost or [::1]; `same-origin`, `none` and an absent header (curl, tests) pass. It is not authentication, and a local process can omit the headers. It covers every mutating route of the module (`push`, `replay`, `retry`, `dlq/:id/replay`, `dlq/:id/clear`, `pending/:id/give-up`, the two deletions).
- **Older app-core:** Without the guard these routes are open to any web page. Run `app-core-cli update`, then restart the server: a server started before the update keeps the old code until restarted. `backend.realServer.integration.test.ts` fails with this instruction when its app-core-cli is older.
- **Risk accepted:** Loss of old logs and history (beyond the retention window anyway, or deleted on purpose); deleted history days lower the counters and make their events non-replayable.
- **Audit:** Each delete or prune writes one `LogFilesPage` diagnostic line in the day log (the page's "last action" card is in memory and disappears at module restart). The module process may thereby create today's file and trigger the retention; harmless, same policy.

### HTTP subscriber receiving sensitive payload data

- **Threat:** HTTP subscribers receive the full event payload. If the target URL is untrusted or the request is logged by a proxy, payload data is exposed.
- **Mitigation:** None in the tool. Callers control the URL and headers. Use `when:` filters to limit which payloads are forwarded.

### Relay-sourced events pushed into the daemon (queue-relay-client)

- **Threat:** The relay client (`packages/queue-relay-client` + per-Source plugins like `packages/plugin-github`) pushes events it received from a remote relay into the local daemon via the same `push` RPC any local process can already call. A compromised or malicious relay could push arbitrary payloads.
- **Mitigation:** The relay already authenticates the webhook source (HMAC verification, GitHub's `X-Hub-Signature-256`) and the relay connection itself is token-authenticated (`relay.yml`'s Consumer token) — this is a trust transfer, not a new attack surface: pushing a relay-sourced event is no more privileged than any other local process calling `push` directly (same accepted risk as "Local process calling daemon RPC" above).
- **Risk accepted:** Same single-user local trust model; the relay's own auth (out of this tool's scope) is the actual control point.

### Relay payload contents and token transport

- **Threat (data):** Relay payloads (GitHub PR bodies, commit author emails, private-repo content) are pushed like any other payload, so they land verbatim in `wal.ndjson`, `dlq.ndjson` and `history/` (91 calendar days, 200 MB). The client applies no size cap and no field projection.
- **Mitigation:** `eventType`/`payloadMatch` in `relay.yml` limit what is delivered; `relay.log` records delivery ids, event names and errors but never payloads.
- **Risk accepted:** Same as "Sensitive data in WAL / DLQ" and "history/" above; do not subscribe to events whose payloads must not be stored locally.
- **Threat (token):** The Consumer token is sent as the first websocket message.
- **Mitigation:** `relayUrl` must be `wss://`; `ws://` is only accepted for localhost (config validation, `queue relay start` fails otherwise).
- **Threat (dotted `payloadMatch`):** The relay only compares top-level payload keys. A dotted key is evaluated on the client, never by the relay, so it cannot widen what the relay delivers beyond the coarse `source` + `eventType` filter.

### Prompt injection into agent sessions (`type: action`, `agent-wake`)

- **Threat:** An `agent-wake` subscriber turns event text (a relay webhook: PR title, commit message, issue body) into input of a Claude Code session. Anyone who controls that text can try to instruct the agent; a payload that picks the recipient could also aim it at another session.
- **Mitigation:** `to` must be a UUID or `project:<folder>`, checked on the rendered value too, so a payload cannot name anything else; `mode: passive` queues the message without waking the session (recommended for untrusted sources); `from` defaults to `queue:<event>` so the consumer can show the origin; `text` is capped (16 KB) and a NUL is refused; `mode` is a literal (a payload cannot choose `wake`). Use `when:` to limit which events reach an agent.
- **Risk accepted:** Text from an allowed source still reaches the agent. A session id or project folder written by a payload field is accepted if it matches the pattern.

### Settings of an action in the dashboard

- **Threat:** `with` may hold a token, a recipient or a message; `GET /subscribers` travels to a browser.
- **Mitigation:** every `with` value is masked (`***`), keys are kept, like `headers` and `env`.

### Forged `$eventRef` and the reserved `queue.` namespace

- **Threat:** The events the daemon emits about the dead-letter queue carry `original: { "$eventRef": "<eventId>" }`, and a template placeholder that walks into it reads the payload of another event from the history. A client that pushes `{"x": {"$eventRef": "<victim id>"}}` (or a `queue.dlq.added` event, or an `origin` in its body) could make a subscriber template read a payload it never sent.
- **Mitigation:** one policy, `canResolveRef` (`dispatch/refResolver.ts`): a reference is followed only when `meta.origin === 'queue'` (set by the daemon's internal push, never read from a request, kept through WAL, DLQ, retry and replay), the event is exactly `queue.dlq.added` or `queue.dlq.removed`, and the reference sits at the top-level key `original`. Anything else is plain data. The `queue.` namespace is reserved on every external entry (wire push, `emit` action at load time and run time, `register-events`, replay of a `queue.*` trigger), so no client can produce an event the policy accepts. Only the payload of the base event is returned (not its metadata), one level deep (a reference in a resolved payload is not followed), by event id (an unguessable UUID). Templates only: `when:`, http bodies and stdin never resolve. Errors name the reference, never a value.
- **Wildcard subscribers** (`*`, `queue.>`) and the history see only the reference, not the base payload: the event adds no copy of sensitive data to the WAL, DLQ, history or an http subscriber's body. A subscriber whose template reads `original` receives base fields, as it would from the original event.
- **The events themselves** (`queue.dlq.added` / `queue.dlq.removed`) carry facts and the reference, never the base payload (asserted by a test: no key of the base payload appears in a built event). They do carry `error` (capped at 500 characters), which may quote a command output or message; a subscriber on `>` or `queue.>` sees it. No event is emitted about a `queue.` base event (no storm from a failing subscriber) and the hop cap bounds a chain.
- **Rule: no client supplies event data.** The daemon RPCs that change the DLQ (`give-up {id}`, `give-up-stuck`, `dlq-clear {id?}`, `dlq-replay {id}`) take an id or nothing; the daemon runs the operation and builds each `queue.dlq.*` event from the rows it moved or removed, so a client cannot choose the event, subscriber, project, `$eventRef`, hops or `causedBy`, nor multiply events (a repeated give-up is `not-in-flight`; a clear emits in batches of 10). There is no `dlq-notify`. Without a running daemon the dashboard edits the files and says no event was sent. Residual: a local RPC client can still clear or give up entries (it already could).
- **Risk accepted:** a daemon older than push protocol 1.5.0 accepts `queue.` names from a client; it also builds no such event. The id of a base event is a capability for `queue history --event-id` for any local process (see the local RPC threat).

### Action loops and fan-out

- **Threat:** An action that emits an event another action (or itself) listens to loops; one event can also fan out to many actions.
- **Mitigation:** a hop counter (cap 5, set only by the daemon from its own push, never from the wire, kept through WAL, DLQ, retry and dlq-replay), a per-root emission budget (100 events per chain, root id carried by the daemon like the hop counter, in-memory map bounded by 1 hour and 10 000 roots), refusal of `before*` emits, a 64 KB cap on the emitted payload, and a static cycle check in `queue sub add|edit` and at daemon start (parent and child project files included). A timed-out action run is superseded: it can no longer push, so a retry cannot double-emit.
- **Risk accepted:** `queue replay` resets the counter and starts a new root. A `cli` subscriber that runs `queue push` re-enters through the RPC at hop 0 with a new root: the runtime caps cover actions only, and neither the budget nor the static check sees that loop (the counters cannot be taken from the wire without letting a client forge them). The budget resets at daemon restart.

## Out-of-scope threats

- Supply-chain attacks on npm dependencies (use `npm audit`)
- Attacks against the remote HTTP endpoints that subscribers call (not this tool's responsibility)
