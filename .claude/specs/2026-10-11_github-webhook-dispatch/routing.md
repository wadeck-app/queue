# Routing & Registration Model -- GitHub Webhook Dispatch

**Version:** v0.1
**Last updated:** 2026-10-11
**Status:** Draft

## Overview

How an inbound webhook delivery from any provider gets from the relay's receiver endpoint to the right consumer(s). Does NOT cover HMAC verification mechanics (Open Question #3c) or the filter expression language itself (Open Question #3b) -- this module defines the entities and their relationships only.

## Decisions

| # | Decision | Rationale | Date |
|---|---|---|---|
| 3 | Entities: Source (provider type) -> WebhookConfig (one registered endpoint instance) -> normalized event stream -> Subscription (consumer + filter). | See `_index.md` Decision #3. | 2026-10-11 |
| 3b | Subscription filter = structured only: `{ source, eventType[], payloadMatch: flat key=value list }`. No JSONPath. | See `_index.md` Decision #3b -- user chose to start simple, revisit if the flat model proves insufficient. | 2026-10-11 |

## Design

### Entities

- **Source**: a provider type (`github`, `slack`, `jira`, ...). Defines how verification works for that provider class (e.g. for `github`: `X-Hub-Signature-256` HMAC-SHA256) and what the normalized envelope looks like for events of that type. Not itself a credential holder.
- **WebhookConfig**: one registered instance of a webhook for a given Source -- e.g. one GitHub repo's or org's webhook. Holds: its own secret (used for HMAC verification), the receiver path/URL it is bound to, and metadata (which repo/org it belongs to, created-at, etc). Multiple WebhookConfigs can exist per Source (e.g. two different repos, each with their own GitHub webhook secret).
- **Consumer**: a registered Queue instance, authenticated via the high-entropy token from Decision #2. Independent of any Source/WebhookConfig.
- **Subscription**: links a Consumer to a filter evaluated against the normalized event stream. A Subscription is NOT tied to a specific WebhookConfig by default -- the consumer's filter decides what it sees, which may span multiple WebhookConfigs or Sources. Filter shape (Decision #3b): `{ source: string, eventType: string[], payloadMatch: { [flatKey: string]: string } }` -- `source` and `eventType` are matched against the envelope directly; `payloadMatch` is a flat equality check against top-level-ish keys the relay explicitly supports extracting from each provider's payload (no arbitrary nesting, no JSONPath). Adding support for a new payload field a Consumer wants to filter on requires a relay code change today -- accepted trade-off, revisit if this becomes limiting.

### Flow

1. GitHub (or another provider) POSTs to the relay's provider-specific receiver endpoint, identified by the target WebhookConfig (e.g. via a path or header that resolves to one WebhookConfig record).
2. The relay verifies the payload against that WebhookConfig's secret (HMAC for GitHub) **synchronously**, then responds 2xx to GitHub immediately (Decision #3c) -- nothing past this point is on GitHub's response-time budget.
3. Asynchronously, off the request/response cycle: the relay normalizes the payload into a generic envelope (`{ source, webhookConfigId, eventType, receivedAt, deliveryId, payload, headers subset }`), writes it to history/audit storage (Open Question #6), evaluates every active Subscription's filter (Decision #3b) against the envelope, and pushes a copy to each Consumer whose filter matches and is currently connected (Decision #2 auth).
4. No per-Consumer replay/cursor (Decision #4) -- a Consumer that is offline when an event is dispatched simply does not receive that push. The event is still retained in history, queryable later via a planned "past events" endpoint (pull, not push -- not yet designed, depends on #6's storage shape).
5. Every reception (HMAC verification success or failure) is written to history/audit storage with source IP and raw content, independently of whether any Subscription matched.

### Why consumers never touch GitHub config

GitHub only knows about WebhookConfig-level routing (one URL, one secret, per repo/org). It has zero awareness of Consumers or Subscriptions. Adding, removing, or changing which Consumers care about a given repo's events is purely a relay-side Subscription change -- no GitHub webhook settings are ever touched for that.

## Implementation (poc-node)

Implemented across `C:\Workspace_Other\poc-node\lib\webhook-configs.js` (WebhookConfig CRUD, plaintext-secret storage), `lib/webhook-relay.js` (the `/webhook/:source/:webhookConfigId` receiver and the `/relay-ws` Consumer endpoint), wired into `server.js`. Subscriptions are ephemeral and connection-scoped exactly as designed -- a Consumer sends `{ type: "subscribe", filter }` after authenticating, held in an in-memory `Map` for the connection's lifetime, re-sent on reconnect. Verified end-to-end locally: a valid-signature, filter-matching delivery is dispatched to the subscribed Consumer; a valid-signature delivery that doesn't match the filter is correctly withheld; an invalid signature is rejected with 401 and never dispatched; all three are still written to history regardless of outcome.

## Open questions

None currently.

## Security considerations

- Rejects Option A (single shared secret, broadcast to all) because it collapses Source/WebhookConfig/Consumer into one trust domain for *authentication purposes* -- see `threat-model.md` T-03. This is distinct from authorization scoping, addressed next.
- **Confirmed by design (not a gap):** there is no per-Consumer access-control boundary at the Subscription or WebhookConfig level. Every authenticated Consumer has equal access to all WebhookConfigs -- any Consumer can both subscribe to any existing WebhookConfig's events and register new WebhookConfigs. This matches the actual trust model: all Consumers belong to the same owner (the user's own Queue instances across machines), there is no multi-tenancy *between untrusted parties*, only multiple authenticated instances of the same owner. Decision #2's "public, multi-tenant" framing refers to the relay being reachable by anyone on the internet (hence per-Consumer tokens to keep strangers out entirely), not to isolating Consumers from each other once authenticated. T-03 (Information Disclosure) therefore only needs to guard against *unauthenticated* access, not inter-Consumer isolation.
