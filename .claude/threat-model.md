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
| `relay.yml` (`QUEUE_CONFIG_DIR`) | High — holds the relay Consumer token (high-entropy bearer credential for the remote webhook relay) | Same filesystem trust boundary as `subscribers.yml` |

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

### HTTP subscriber receiving sensitive payload data

- **Threat:** HTTP subscribers receive the full event payload. If the target URL is untrusted or the request is logged by a proxy, payload data is exposed.
- **Mitigation:** None in the tool. Callers control the URL and headers. Use `when:` filters to limit which payloads are forwarded.

### Relay-sourced events pushed into the daemon (queue-relay-client)

- **Threat:** The relay client (`packages/queue-relay-client` + per-Source plugins like `packages/plugin-github`) pushes events it received from a remote relay into the local daemon via the same `push` RPC any local process can already call. A compromised or malicious relay could push arbitrary payloads.
- **Mitigation:** The relay already authenticates the webhook source (HMAC verification, GitHub's `X-Hub-Signature-256`) and the relay connection itself is token-authenticated (`relay.yml`'s Consumer token) — this is a trust transfer, not a new attack surface: pushing a relay-sourced event is no more privileged than any other local process calling `push` directly (same accepted risk as "Local process calling daemon RPC" above).
- **Risk accepted:** Same single-user local trust model; the relay's own auth (out of this tool's scope) is the actual control point.

## Out-of-scope threats

- Supply-chain attacks on npm dependencies (use `npm audit`)
- Attacks against the remote HTTP endpoints that subscribers call (not this tool's responsibility)
