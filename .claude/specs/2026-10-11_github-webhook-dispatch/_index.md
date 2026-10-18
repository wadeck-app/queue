# Spec: GitHub Webhook Dispatch

**Created:** 2026-10-11
**Version:** v0.1
**Status:** In Review -- v0.1 -- 6/6 questions resolved
**Iteration:** 1

## Summary

A Queue plugin that receives GitHub webhook events (starting with pull request events) and dispatches them as local events to interested agents. GitHub webhooks require a publicly reachable HTTPS endpoint; this spec covers how that public ingress is bridged to Queue running on a local machine with no public address, and how Queue then fans the events out locally.

## Decision Log

| # | Decision | Status | Date | Rationale |
|---|---|---|---|---|
| 1 | Relay transport = dedicated Node.js/Fastify service on Infomaniak (poc-node stack), using native WebSocket push. Rejected: WDrive (PHP-FPM, no persistent process, confirmed by wdrive-owner), smee.io/tunnel (third-party trust boundary), GitHub API polling (diverges from "webhook" requirement). | Resolved | 2026-10-11 | Live test on https://assistant.wadeck.ch/chat-ws confirmed the WebSocket stays OPEN for 353s (23 ping/pong cycles, stable ~335-345ms RTT, zero drops/reconnects) through Infomaniak's real reverse proxy -- past the 300s limit the page itself warns about. This is the only option with infra already proven to support real-time push rather than polling. |
| 1b | Finding (not a decision): transport-layer mTLS (TLS-handshake client cert verification) is confirmed infeasible on this host. | Finding | 2026-10-11 | Live probe (`/api/tls-info` on the relay) confirmed `socketEncrypted: false`, no peer certificate, no client-cert-related headers forwarded -- TLS is terminated at Infomaniak's edge before reaching the Node process. This only rules out verifying a client cert *at the TLS handshake*. It does NOT rule out certificate/key-based auth implemented at the application layer (client signs a request/challenge with a private key, server verifies the signature in code) -- that doesn't depend on the TLS termination point at all. See Open Question #2. |
| 2 | Client auth model for the relay = random high-entropy API token, server stores only its hash (not the plaintext). | Resolved | 2026-10-11 | Scored across security/performance/maintainability/resilience/readability against 8 candidates (static bearer, short-lived JWT, app-layer signature, signed handshake + session secret, hashed token, username/password, Diffie-Hellman, per-request HMAC). Chosen because the relay is public and not single-tenant (user's own words: "serveur public et je ne suis pas le seul user") -- protects the relay's credential store at rest for near-zero extra cost over a plain bearer token. Diffie-Hellman and username/password were explicitly rejected: DH alone solves confidentiality, not authentication (the actual threat, T-02), and TLS already covers confidentiality; username/password is a human-auth pattern with no benefit over a random token for a machine client. |
| 3 | Routing/registration model = Source (provider type: github, slack, ...) -> WebhookConfig (one registered endpoint instance: its own secret/verification config, URL, metadata) -> Subscription (a consumer registers a filter expression against the normalized event stream; GitHub/the provider never needs to know about individual consumers). No access-control boundary between Consumers: all authenticated Consumers can see and configure all WebhookConfigs -- there is no "user A vs user B" isolation, only "authenticated vs not" (Decision #2). | Resolved | 2026-10-11 | Chosen over (A) single shared secret broadcasting to every connected consumer -- rejected, violates least-privilege and guarantees T-03 over-sharing -- and (C) consumer-scoped webhook URLs with the token embedded in the GitHub Payload URL -- rejected, leaks a bearer-equivalent credential into GitHub's own logs/UI and doesn't generalize to other providers. User's explicit requirement: each consumer "puisse se sub uniquement aux events qui l'interesse, sans devoir changer qqch sur GitHub" -- the relay receives everything, consumers pull what they want via a filter, decoupling GitHub-side config from consumer-side interest entirely. Clarified afterward: "pas besoin de separation entre les users, ils ont tous acces a tous les webhook a disposition et peuvent tous en configurer des nouveaux" -- Decision #2's "multi-tenant" framing is about keeping unauthenticated strangers off a public relay, not about isolating Consumers from each other once authenticated; all Consumers are instances the same owner controls. |

| 3b | Subscription filter mechanism = structured filter only: `{ source, eventType[], payloadMatch: flat key=value list }`. No JSONPath, no nested/recursive matching. | Resolved | 2026-10-11 | User chose to start simple ("démarre avec l'option B pour rester simple et on ajustera si besoin"), explicitly leaving room to add JSONPath/hybrid later if the flat key=value model proves insufficient. Avoids any filter-evaluation DoS surface entirely (no recursive traversal to bound), at the cost of needing a code change if a Consumer needs to match a field not yet in the relay's supported list -- accepted trade-off for now. |
| 3c | Receiver endpoint ordering: verify HMAC synchronously (fast crypto op), respond 2xx immediately, THEN do storage/filtering/dispatch asynchronously off the request/response cycle. | Resolved | 2026-10-11 | User's explicit requirement: "il faut surtout que le relay reponde au webhook le plus vite possible, PUIS fais son processing des events (storage, filtering, dispatch)." Keeps the relay well under GitHub's 10s response budget regardless of downstream load (slow Consumer, audit-log write contention, etc.) and avoids GitHub ever marking the webhook as broken because processing was slow -- GitHub has no visibility past the HTTP response, so decoupling response from processing is strictly a relay-side win with no downside. |
| 4 | No per-Consumer replay buffer/cursor (Option A: fire-and-forget to currently-connected Consumers only). Full event history is still retained (ties into #6), and a query endpoint for "past events" is a planned feature -- but it is a pull-on-demand query over shared history, not a per-Consumer tracked replay. | Resolved | 2026-10-11 | User's explicit choice: "Option 4A pour le moment, mais on garde l'historique... avoir un endpoint pour les events 'passe' reste une bonne feature a avoir, mais pas de save par consumer." Avoids the per-Consumer cursor/eviction complexity Option B would have needed, while keeping the door open to catch-up via an explicit history query rather than automatic push-replay. |
| 6 | History/audit storage = flat append-only JSON Lines log file, rotated/evicted to stay within 180 days and 50MB (oldest-first). | Resolved | 2026-10-11 | User's explicit choice: keep it simple -- no database. |
| 5 | Queue wraps the relay's event envelope into a Queue-native event (its own event/subscriber mechanism) at the Queue-plugin boundary. The relay itself knows nothing about Queue -- it is one Consumer among potentially several. | Resolved | 2026-10-11 | User's explicit rationale: "le relay ne doit rien savoir de queue! car ce ne sera pas le seul consommateur!" Keeps the relay provider-and-consumer-agnostic (matches Decision #3's extensibility goal); translation to Queue's idiom is entirely the Queue plugin's responsibility. |

## Open Questions

| # | Question | Priority | Status |
|---|---|---|---|
| - | *(none currently -- all open points resolved; next step is an implementation plan)* | - | - |

## Modules / Sub-files

| File | Contents |
|---|---|
| `guiding-principles.md` | Core principles driving all decisions |
| `out-of-scope.md` | Explicitly excluded items |
| `threat-model.md` | Security threats and mitigations |
| `relay-transport.md` | Relay hosting/transport choice (Node.js/Fastify on Infomaniak) |
| `auth.md` | Consumer<->relay authentication (high-entropy token + server-side hash) |
| `routing.md` | Source/WebhookConfig/Subscription routing model and filter mechanism |
| `history-storage.md` | Audit/history log storage and retention |

## Changelog

| Version | Date | Summary |
|---|---|---|
| v0.1 | 2026-10-11 | Initial spec created |
| v0.1 | 2026-10-11 | Decision #1: relay transport = Node.js/Fastify on Infomaniak, confirmed via live WebSocket test |
