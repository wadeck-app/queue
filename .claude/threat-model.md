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
| `history/` | Medium — every trigger record stores the push payload verbatim (for `queue replay`), same sensitivity as WAL/DLQ | Bounded by `HistoryLog`'s day-based retention window (default 30 days, pruned on every write), unlike WAL (cleared on completion) or DLQ (bounded via `maxSize` eviction) which clear/evict individual entries |
| Daemon port (47910) | Medium — any local process can send RPC commands | Localhost only |
| `_secrets_/.env.local` (`QUEUE_CONFIG_DIR`) | High — holds `QUEUE_RELAY_TOKEN`, the relay Consumer token (high-entropy bearer credential for the remote webhook relay) | Gitignored `_secrets_/` folder, protected from agents by the w-guardrails plugin; the daemon reads it, nothing prints it (errors name the path, never the value). Also accepted: env `QUEUE_RELAY_TOKEN`. A `.env.local` outside `_secrets_/` is a hard error. |
| `relay.yml` (`QUEUE_CONFIG_DIR`) | Medium — relay URL, plugins and subscriptions. A `token:` entry is still accepted but deprecated (plaintext, `relay start` warns) | Same filesystem trust boundary as `subscribers.yml` |

## Threats and mitigations

### Arbitrary command execution via subscriber config

- **Threat:** If `subscribers.yml` is writable by an attacker, they can register arbitrary shell commands that execute on the next matching event.
- **Mitigation:** OS-level file permissions on `~/.config/queue/` and `.queue/`. The tool does not add its own access controls.
- **Risk accepted:** Single-user local tool; file system is the trust boundary.

### Event payload injection into CLI commands

- **Threat:** A `cli` subscriber may template event payload values into its command string. If the `command` field is built with user-controlled payload data, shell injection is possible.
- **Mitigation:** <!-- TODO: verify how CliTransport executes commands — check if it uses shell: true or spawn with argument array; shell injection risk differs significantly -->
- **Risk:** Unknown until `CliTransport.ts` is audited.

### Local process calling daemon RPC (port 47910)

- **Threat:** Any process on the local machine can connect to the daemon port and push arbitrary events, trigger retries, or replay DLQ entries.
- **Mitigation:** Accepted risk — single-user local tool; all local processes under the same OS session already have write access to `subscribers.yml` and config files directly.

### Sensitive data in WAL / DLQ

- **Threat:** Event payloads passed via `queue push <event> <json>` are written verbatim to `wal.ndjson` and `dlq.ndjson`. If payloads contain secrets (API keys, passwords), they persist on disk.
- **Mitigation:** No mitigation in the tool. Callers must not pass sensitive values as event payloads.
- **Risk accepted:** Caller responsibility; documented in usage.

### Sensitive data in history/ (queue replay payload storage)

- **Threat:** Since `queue replay <eventId>` needs the original payload, `HistoryLog.logTrigger` persists it verbatim in `history/<date>.ndjson`, readable in full via `queue history --json`. Same payload-contains-secrets risk as WAL/DLQ above, but history has no per-entry clearing (WAL clears on ack, DLQ evicts past `maxSize`) -- without a bound, it would retain every payload forever.
- **Mitigation:** `HistoryLog` prunes day files older than `retentionDays` (default 30) on every write, so a payload is never kept longer than that window.
- **Risk accepted:** Within the retention window, caller responsibility not to push secrets as payloads (same as WAL/DLQ).
- **Dashboard exposure:** The app-core module's `GET /api/modules/queue/history` also returns each payload as `payloadText` (indented JSON, capped at 20,000 characters; a second copy next to `payload`), rendered in the Queue History page's expandable rows. Same sensitivity as `queue history --json`, but reachable by anything that can call app-core's HTTP API (localhost); do not expose app-core beyond localhost without authentication.

### HTTP subscriber receiving sensitive payload data

- **Threat:** HTTP subscribers receive the full event payload. If the target URL is untrusted or the request is logged by a proxy, payload data is exposed.
- **Mitigation:** None in the tool. Callers control the URL and headers. Use `when:` filters to limit which payloads are forwarded.

### Relay-sourced events pushed into the daemon (queue-relay-client)

- **Threat:** The relay client (`packages/queue-relay-client` + per-Source plugins like `packages/plugin-github`) pushes events it received from a remote relay into the local daemon via the same `push` RPC any local process can already call. A compromised or malicious relay could push arbitrary payloads.
- **Mitigation:** The relay already authenticates the webhook source (HMAC verification, GitHub's `X-Hub-Signature-256`) and the relay connection itself is token-authenticated (`relay.yml`'s Consumer token) — this is a trust transfer, not a new attack surface: pushing a relay-sourced event is no more privileged than any other local process calling `push` directly (same accepted risk as "Local process calling daemon RPC" above).
- **Risk accepted:** Same single-user local trust model; the relay's own auth (out of this tool's scope) is the actual control point.

### Relay payload contents and token transport

- **Threat (data):** Relay payloads (GitHub PR bodies, commit author emails, private-repo content) are pushed like any other payload, so they land verbatim in `wal.ndjson`, `dlq.ndjson` and `history/` (30 days). The client applies no size cap and no field projection.
- **Mitigation:** `eventType`/`payloadMatch` in `relay.yml` limit what is delivered; `relay.log` records delivery ids, event names and errors but never payloads.
- **Risk accepted:** Same as "Sensitive data in WAL / DLQ" and "history/" above; do not subscribe to events whose payloads must not be stored locally.
- **Threat (token):** The Consumer token is sent as the first websocket message.
- **Mitigation:** `relayUrl` must be `wss://`; `ws://` is only accepted for localhost (config validation, `queue relay start` fails otherwise).
- **Threat (dotted `payloadMatch`):** The relay only compares top-level payload keys. A dotted key is evaluated on the client, never by the relay, so it cannot widen what the relay delivers beyond the coarse `source` + `eventType` filter.

## Out-of-scope threats

- Supply-chain attacks on npm dependencies (use `npm audit`)
- Attacks against the remote HTTP endpoints that subscribers call (not this tool's responsibility)
