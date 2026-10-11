**Spec:** .claude/specs/2026-10-11_github-webhook-dispatch/

# Plan: Queue-side GitHub Webhook Relay Client (Phase 2)

## Context

Phase 1 (the relay itself, in a separate repo `C:\Workspace_Other\poc-node`) is built, deployed, and now stable: it receives GitHub webhooks, verifies HMAC, normalizes them into a provider-agnostic envelope, and pushes matching events to connected Consumers over `/relay-ws`. It is deliberately Queue-agnostic (Decision #5 in the spec) — "the relay doesn't know Queue exists."

Phase 2, never started, is the other half: a Queue-side plugin that connects to that relay as a Consumer, receives envelopes, and turns them into real `queue push` calls so local subscribers (CLI/HTTP) can react to GitHub events. This plan designs that plugin, including an explicit extension point so other relay Sources (Slack, Jira, ...) can be added later without forking the connection logic.

Two architectural constraints drive the design, found during codebase research (not assumptions):
- **`QueueDaemon` self-terminates after 60s idle** (`IDLE_TIMEOUT_MS` in `packages/queue-core/src/daemon/QueueDaemon.ts`) with no "keep-alive" hook. A persistent relay listener must NOT live inside the daemon's own process lifecycle, or it either gets killed or has to disable idle-shutdown entirely (unacceptable — defeats an existing feature for every other user).
- **No WebSocket/persistent-connection primitive exists anywhere in this codebase** (`queue-core`, `queue-cli`, `app-module-queue`, or app-core's `ModuleContext`) to reuse. This is new infrastructure, not a gap-fill in an existing extension mechanism.

Consequence: the relay client must be its **own independent long-running process**, decoupled from the daemon's lifecycle, that calls the existing `push` RPC on demand (spawning the daemon if it's asleep) rather than running inside it.

## Design

### New package: `packages/queue-relay-client`

A new workspace package, sibling to `queue-core`/`app-module-queue`, following the one-concern-per-package convention already used in this monorepo. Depends on `@wadeck-app/queue-core` (for `startDaemon`, `PushRequest`/`PushResponse` types, `createDaemonClient` pattern) and `@wadeck-app/singleton-daemon-kit` (same singleton-process + port-file + RPC pattern `QueueDaemon.ts` already uses — reused here for a *different* purpose: guaranteeing only one relay-client instance runs, and exposing a tiny `status` command, not for dispatch).

Rationale for a new package over bolting onto `app-module-queue`: `app-module-queue` is a stateless library of one-shot request/response calls (`push.ts`, `status.ts`, etc.) with no own process — confirmed via exploration, and explicitly flagged by app-core-sdk's `ModuleContext` having zero persistent-connection primitive. This is a daemon-lifecycle feature, architecturally closer to `queue-cli`'s `daemon-entry.ts` than to a dashboard API.

### Lifecycle (mirrors the existing daemon pattern, don't invent a new one)

- `packages/queue-relay-client/src/relay-daemon-entry.ts` — entry point for the background process, same shape as `queue-cli/src/daemon/daemon-entry.ts`.
- `packages/queue-relay-client/src/RelayDaemon.ts` — exports `startRelayDaemon(configDir)`, using `createDaemon` from `singleton-daemon-kit` with its own port constant (e.g. `RELAY_DAEMON_PORT`), command set `{ status: () => RelayStatus }`.
- `queue-cli` gets new subcommands `queue relay start|stop|status`, implemented the same way `spawnDaemon`/`ensureDaemon` work today in `packages/queue-cli/src/cli/QueueIndex.ts` (lines ~266-322) — including the existing Windows-hidden-process trick (`docs/windows-hidden-process.md`, wscript.exe + VBScript SW_HIDE) for `spawnDaemon`. **Extract the current `ensureDaemon`/`spawnDaemon`/hidden-spawn logic out of `QueueIndex.ts` into a small shared exported helper in `queue-core` (e.g. `spawnDetachedProcess(scriptPath, configDir)`)** so both the main daemon and the new relay daemon reuse one implementation instead of duplicating the Windows-hiding trick.

### Decoupling from idle-shutdown

The relay-client process never talks to the main `QueueDaemon` except by calling `push`. Each time it has an event to deliver:
1. Call `client.isRunning()` (same `createDaemonClient` check `app-module-queue/src/client.ts` already does).
2. If not running, spawn it via the shared helper above (same as `queue-cli` does today) and wait for it to come up.
3. Call `pushEvent(configDir, event, payload, opts)` — reuse `packages/app-module-queue/src/push.ts` verbatim, don't reimplement the RPC call.

This means the main daemon keeps idling and self-terminating exactly as it always has; the relay client simply wakes it on demand, same as a human running `queue push` would.

### Relay wire protocol (confirmed from `C:\Workspace_Other\poc-node\lib\webhook-relay.js`, not guessed)

```
connect → wss://<relay-host>/relay-ws
→ { type: "auth", token }
← { type: "authenticated", username }  |  { type: "error", error }
→ { type: "subscribe", filter: { source, eventType: string[], payloadMatch?: Record<string,string> } }
← { type: "subscribed", filter }
← { type: "event", envelope: { source, webhookConfigId, eventType, receivedAt, deliveryId, payload, headers } }
```
One WS connection, one `subscribe` call per configured filter (the relay's filter model is server-side, so multiple interests = multiple `subscribe` messages, or one broad filter — config decides).

### Extension point: `queue-relay-client` is infrastructure, not a plugin — plugins are separate packages

`queue-relay-client` must never contain GitHub/Slack/Jira-specific code (explicit user requirement: it's used *by* every plugin, it is not itself one). It owns the WS connection, auth, reconnect, daemon-wake/push, and config loading. The only GitHub-aware thing anywhere is a separate, tiny new package: `packages/plugin-github`. The same shape repeats for every future Source (`plugin-slack`, `plugin-jira`, ...) — none built now, just enabled by this contract.

`packages/queue-relay-client/src/plugin-api.ts` defines the contract every plugin package implements:
```ts
export interface RelayEnvelope { source: string; webhookConfigId: string; eventType: string; receivedAt: string; deliveryId: string; payload: unknown; headers: Record<string,string>; }
export interface RelayPlugin {
  source: string; // must match the relay's Source identifier, e.g. "github"
  mapEvent: (envelope: RelayEnvelope) => { event: string; payload: unknown } | null; // null = drop
}
```
`packages/plugin-github/src/index.ts` — the entire GitHub-specific package, exporting a `RelayPlugin` default: `{ source: 'github', mapEvent: (envelope) => ({ event: \`on.github.${envelope.eventType}\`, payload: envelope.payload }) }`. Depends on `queue-relay-client` only for the type import — never the other way around.

### Plugin loading + config: new `relay.yml` in `QUEUE_CONFIG_DIR`

`relay.yml` lists which plugin packages to load by name, each with its own subscription filter(s) — `queue-relay-client` dynamically `import()`s each listed module at startup, validates it matches `RelayPlugin`, and uses `plugin.source` both to build the WS `subscribe` filter and to route incoming envelopes back to the right plugin's `mapEvent`. Loaded fresh on every (re)connect attempt — same "no caching, no file-watcher" philosophy `ConfigLoader.ts` already uses for `subscribers.yml`.
```yaml
relayUrl: wss://assistant.wadeck.ch/relay-ws
token: <consumer token, high-entropy, from the relay's claim flow>
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [pull_request, push]
        payloadMatch: {}
        queueEvent: null   # optional override, else plugin's mapEvent default
```
Per-subscription `queueEvent` lets config override a plugin's derived event name — config wins over convention when a user wants a specific name. Lives in the same trust boundary as `subscribers.yml` (filesystem permissions on `QUEUE_CONFIG_DIR`) — no new secret-storage mechanism, consistent with the existing accepted-risk model in `.claude/threat-model.md`.

### Reconnection

Simple exponential backoff (reuse the *concept* already named in `ResolvedSubscriber.backoff: 'exponential'|'linear'`, not the `RetryScheduler` class itself — that's WAL-specific) on WS close/error, with a capped max delay. Re-send `auth` + all configured `subscribe` messages on every reconnect (the relay has no server-side subscription persistence per Decision #4 — confirmed in spec).

### Docs to update (not just code)

- `.claude/threat-model.md`: add the relay token as a new Asset (same sensitivity class as `subscribers.yml` — filesystem trust boundary applies identically), and a new Threat entry for "relay-sourced event injected into the daemon" (accepted risk: the relay already authenticates/HMAC-verifies upstream, same trust transfer as any other push caller).
- `.claude/out-of-scope.md`: the "Message broker / distributed queue — no cross-machine event routing" line needs a one-line carve-out note: this plugin makes Queue a *consumer* of one external push source, it does not turn Queue's own daemon into a distributed broker (no daemon-to-daemon routing is added). Avoids future confusion re-reading that doc.
- `.claude/product-vision.md`: add the relay client to the architecture diagram as a new producer alongside the CLI, feeding the same `push` entry point.

## Files to create/modify

| File | Change |
|---|---|
| `packages/queue-relay-client/package.json`, `tsconfig.json`, `src/` | New package — generic engine only, no Source-specific code |
| `packages/queue-relay-client/src/relay-daemon-entry.ts` | Background process entry point |
| `packages/queue-relay-client/src/RelayDaemon.ts` | `startRelayDaemon()`, singleton-daemon-kit wiring |
| `packages/queue-relay-client/src/RelayConnection.ts` | WS connect/auth/subscribe/reconnect loop |
| `packages/queue-relay-client/src/plugin-api.ts` | `RelayPlugin`/`RelayEnvelope` contract + dynamic plugin loader |
| `packages/queue-relay-client/src/config.ts` | `relay.yml` zod schema + loader (mirrors `ConfigLoader.ts` style) |
| `packages/plugin-github/package.json`, `src/index.ts` | New package — the actual GitHub plugin, implements `RelayPlugin` |
| `packages/queue-core/src/daemon/spawnDetachedProcess.ts` (new, extracted) | Shared hidden-spawn helper, used by both daemons |
| `packages/queue-cli/src/cli/QueueIndex.ts` | New `relay start|stop|status` subcommands; switch existing `spawnDaemon` to the extracted helper |
| `.claude/threat-model.md`, `.claude/out-of-scope.md`, `.claude/product-vision.md` | Doc updates described above |

## Verification

1. **Unit tests** (same convention as existing `.test.ts` files): zod schema validation for `relay.yml`, mapper registry (`github.ts` produces the right `event`/`payload` shape, unknown source returns `null`).
2. **Integration test** (model: `QueueIndex.integration.test.ts`): spin up a local mock WS server implementing the exact `auth`/`subscribe`/`event` protocol above, point `RelayConnection` at it, assert a `push` RPC actually lands in the daemon's WAL and dispatches to a test subscriber.
3. **Manual end-to-end** (only once 1-2 pass): register a real WebhookConfig + Subscription on the now-stable `poc-node` relay, claim a Consumer token, configure `relay.yml`, run `queue relay start`, trigger a real GitHub webhook (or GitHub's "Redeliver" button on an existing delivery), confirm it reaches a local `cli`/`http` subscriber end-to-end.
