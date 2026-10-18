**Spec:** .claude/specs/2026-10-11_github-webhook-dispatch/

# Plan: GitHub Webhook Relay + Queue Dispatch

## Context

The spec at `.claude/specs/2026-10-11_github-webhook-dispatch/` is fully resolved (6/6 decisions). It covers two separate systems that need to be built in two separate repos:

1. **The relay** (`C:\Workspace_Other\poc-node`, `server.js`) -- a public Node.js/Fastify service on Infomaniak that receives GitHub webhook POSTs, verifies them, stores a full history, and pushes matching events to connected Consumers over WebSocket. It must stay Queue-agnostic (Decision #5) -- it has no idea Queue exists, Queue is just one Consumer.
2. **The Queue plugin** (`C:\Workspace_Tooling\queue`, new package) -- connects to the relay as a Consumer, subscribes to the events it cares about, and translates each one into a Queue-native event via `queue-core`'s existing `push` daemon RPC.

Given the size of this (new auth model, new routing entities, new persistence, a brand-new outbound WebSocket client pattern that doesn't exist anywhere in the Queue repo today), **this plan implements the relay side (poc-node) now, and explicitly treats the Queue plugin as a separate follow-up** -- it is not implemented in this pass. The relay can be deployed and tested end-to-end (verified via `curl`/GitHub's "Redeliver" against a real webhook) before the Queue plugin exists, since nothing on the relay depends on Queue.

**Explicitly flagged scope boundary (partial-implementation disclosure):** after this plan, GitHub events will reach the relay, be verified, stored, and be deliverable over WebSocket to any client that authenticates and subscribes -- but Queue itself will NOT yet receive or dispatch them locally. That requires the Phase 2 plugin package, planned but not built here.

## Current state (from exploration)

- `server.js` is a single 2077-line file, no router split, no JSON-schema validation lib. Fastify 4, `@fastify/websocket`.
- Auth today (`server.js:102-298`) is **one single global token**: `auth-token-hash.json` = `{ hash }`, checked via `crypto.createHash('sha256')` + `timingSafeEqual`, backing one shared browser session cookie (`qauth`, in-memory `sessions` Map, 24h TTL). No per-identity concept exists -- this plan replaces it with a multi-consumer model.
- WebSocket routes (`/ws` server.js:1576, `/chat-ws` server.js:1603) ride on the same session cookie via the global `onRequest` hook (server.js:251) -- no separate per-connection auth today.
- `crypto.createHmac`/`timingSafeEqual` are already available (built-in `crypto`, already imported at server.js:15) -- no new dependency needed for GitHub's `X-Hub-Signature-256`.
- Disk persistence pattern used today: whole-file JSON read on boot, whole-file overwrite on change (`auth-token-hash.json`). New state follows the same pattern (`consumers.json`, `webhook-configs.json`), plus a new append-only JSONL file for history.

## Implementation (poc-node)

### 1. Multi-consumer auth with username + PIN claim flow

Replace the single global token with named Consumers, per the user's explicit design:

- `consumers.json`: `{ consumers: [{ username, tokenHash, createdAt, isAdmin }] }`.
- **Migration**: on boot, if the legacy `auth-token-hash.json` exists and `consumers.json` doesn't, migrate it into one consumer with `username: "admin"`, `isAdmin: true`, same hash -- satisfies "ajoute un username aux token aussi, y compris le premier."
- **Creating a new consumer** (admin session only): `POST /api/consumers` `{ username }` -> server generates a high-entropy token (same scheme as Decision #2) and a 6-digit PIN, keeps a short-lived (~5 min) in-memory pending registration `{ username, pin, token, expiresAt }`, and shows the PIN to the admin (not the token).
- **Claiming it** (public, unauthenticated endpoint -- this is how a brand-new client proves it's the intended recipient without ever seeing an admin session): `POST /api/consumers/claim` `{ username, pin }` -> on match within the expiry window, returns the plaintext token once, stores only its hash in `consumers.json`, discards the pending registration. Wrong/expired PIN -> generic 401, no hinting.
- Login (`POST /api/login`) now looks up by hashing the submitted token and scanning `consumers.json` hashes (small N, fine) instead of comparing against one global hash.
- Each WebSocket connection authenticates with a Consumer token sent as the first message after upgrade (`{ "type": "auth", "token": "..." }`) rather than relying on the browser session cookie -- this is what lets the Queue plugin (a non-browser client) connect directly without a cookie/session dance.

### 2. WebhookConfig registration (admin-gated, source-agnostic shape)

- `webhook-configs.json`: `{ configs: [{ id, source: "github", name, secret, createdAt }] }`.
- Secret is stored **in plaintext** (not hashed) -- unlike Consumer tokens, HMAC verification requires the relay to recompute the HMAC itself, which is only possible with the plaintext secret. This is a necessary, standard trade-off (matches how GitHub itself expects you to hold the secret) and should be called out in the threat model as a known plaintext-at-rest item, scoped to file permissions.
- `POST /api/webhook-configs` `{ source, name }` (admin-gated) generates a high-entropy secret, returns it so the admin can paste it into GitHub's webhook settings UI. `GET /api/webhook-configs` lists existing ones (secret included -- the admin needs to re-view it if they're reconfiguring GitHub).

### 3. Webhook receiver endpoint

- Route: `POST /webhook/:source/:webhookConfigId` (e.g. `/webhook/github/<id>`), added to the auth bypass list (today an exact-match array at server.js:113 -- needs to become prefix-aware, e.g. a small `isBypassPath(path)` helper matching `AUTH_BYPASS_PATHS` exactly OR `path.startsWith('/webhook/')`).
- Raw body capture: Fastify's default JSON parser discards the raw bytes needed for HMAC. Add a custom `addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` scoped to this route (or globally, re-parsing JSON after HMAC check) so the exact bytes GitHub signed are what gets hashed.
- Verification: look up the WebhookConfig by `webhookConfigId`, compute `crypto.createHmac('sha256', config.secret).update(rawBody).digest('hex')`, compare against the `X-Hub-Signature-256` header (strip `sha256=` prefix) via `timingSafeEqual`.
- **Ordering per Decision #3c**: verify synchronously, respond immediately (200 if valid, 401 if invalid -- GitHub only auto-flags a hook unhealthy on repeated failures, which is correct signal for a bad secret), THEN (fire-and-forget, not awaited by the response) write to history and, if valid, dispatch to matching Subscriptions.

### 4. Subscriptions (ephemeral, per-connection -- no persistence needed per Decision #4)

- After a Consumer's WebSocket authenticates (step 1), it sends `{ "type": "subscribe", "filter": { "source": "github", "eventType": ["pull_request"], "payloadMatch": { "action": "opened" } } }`.
- Server keeps `{ connection -> filter }` in an in-memory Map for the connection's lifetime. Reconnecting means re-subscribing -- consistent with "no per-Consumer replay buffer" (Decision #4).
- On a valid, HMAC-verified event, iterate connected consumers' filters: `source`/`eventType` exact/array-membership match, `payloadMatch` flat key equality against the normalized payload -- push the full normalized envelope to every match.

### 5. History storage (JSON Lines, 180-day / 50MB cap)

- Append one line per reception (valid or invalid) to `webhook-history.jsonl`: `{ receivedAt, source, webhookConfigId, sourceIp, verified, eventType, deliveryId, payload }`.
- A periodic sweep (e.g. `setInterval`, hourly) drops lines older than 180 days, then -- if the file is still over 50MB -- drops oldest lines further until under the cap. Implemented as "read all lines, filter, rewrite" (fine at this size; this file is explicitly capped at 50MB so a full rewrite is cheap).
- `GET /api/webhook-history` (admin-gated) exposes the "past events" query planned under Decision #4 -- basic filtering by source/eventType/date range over this same file. (Minimal query support for this pass -- a real query language is future scope, not blocking.)

### 6. Threat model / spec file updates

After implementation, update `.claude/specs/2026-10-11_github-webhook-dispatch/`:
- `auth.md`: document the Consumer/PIN-claim flow as the concrete realization of Decision #2.
- `routing.md`: confirm the ephemeral per-connection subscription implementation matches the documented design.
- `threat-model.md`: add the WebhookConfig-secret-stored-in-plaintext item explicitly (new finding, not previously captured).

## Explicitly out of scope for this pass

- The Queue plugin package (`packages/queue-github-webhook` or similar) that connects to the relay and calls `queue-core`'s `push` RPC (`packages/queue-core/src/daemon/QueueDaemon.ts`) to inject Queue-native events -- this is Phase 2, a separate plan, once the relay above is live and stable.
- A real query language for `/api/webhook-history` beyond basic filters.
- Jira/Slack sources -- `source` is a free string today in `webhook-configs.json`/the envelope, but only `github`'s HMAC verification is implemented.

## Verification

- `npm test`/manual boot of `poc-node` locally; confirm migration path by starting with an existing `auth-token-hash.json` fixture and checking it becomes a `consumers.json` entry named `admin`.
- Create a second consumer via the PIN flow end-to-end (two terminal sessions: one "admin" creating it, one "new client" claiming it with the PIN).
- Register a WebhookConfig, use GitHub's "Redeliver" on a real repo webhook (or `curl` with a manually computed `X-Hub-Signature-256`) to confirm: valid signature -> 200 + history line + WS push to a subscribed test client; invalid signature -> 401 + history line (verified: false) + no push.
- Confirm `webhook-history.jsonl` rotation logic with a small forced cap in a test run (not the real 50MB) to avoid waiting for real growth.
