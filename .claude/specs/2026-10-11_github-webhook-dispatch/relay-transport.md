# Relay Transport -- GitHub Webhook Dispatch

**Version:** v0.1
**Last updated:** 2026-10-11
**Status:** Draft

## Overview

Covers how a GitHub webhook payload, sent to a public HTTPS endpoint, reaches Queue on a local machine with no public address. Does NOT cover what Queue does with the event once received locally (see the local event model, Open Question #5).

## Decisions

| # | Decision | Rationale | Date |
|---|---|---|---|
| 1 | Use a dedicated Node.js/Fastify service deployed on Infomaniak (reusing the `poc-node` PoC stack) as the relay, with Queue connecting over a persistent WebSocket for real-time push. | Live verification against `https://assistant.wadeck.ch/chat-ws` showed the connection survives 353s (23 ping/pong cycles) through Infomaniak's production reverse proxy with zero drops -- the only option confirmed to support push rather than polling. WDrive was ruled out: plain PHP-FPM, no persistent-connection support (confirmed by wdrive-owner against the WDrive repo). | 2026-10-11 |

## Design

### What is verified
- A long-lived WebSocket connection through Infomaniak's reverse proxy to a Node.js/Fastify process stays open well past 300s with regular ping/pong (confirmed live, not from docs or commit messages).
- Infomaniak can run a persistent Node.js process via PM2 (confirmed by `poc-node`'s deployment history and the live test itself -- the process serving `/chat-ws` was alive and responsive).

### What is NOT yet built (greenfield, same magnitude of new work regardless of relay choice)
- No webhook receiver endpoint exists yet (`poc-node` has no `/webhook` route) -- see Open Question #3.
- No HMAC signature verification (`X-Hub-Signature-256`) exists yet -- required regardless of transport choice to prevent spoofed events.
- No auth/registration model exists for Queue to connect as a trusted WebSocket client -- `poc-node`'s `/chat-ws` is currently open with no auth at all. See Open Question #2.
- No buffering/replay mechanism exists for when Queue is offline -- see Open Question #4.

## Verified capability matrix (live tests against https://assistant.wadeck.ch, 2026-10-11)

| Capability | Result | Evidence |
|---|---|---|
| WebSocket (`/chat-ws`) | Confirmed stable | 353s open, 23 ping/pong cycles, zero drops, through Infomaniak's production reverse proxy |
| Long polling (`/api/long-poll`) | Confirmed | 10016ms round-trip, no proxy timeout |
| Chunked streaming (`/api/stream`) | Confirmed | 10 chunks received in real time |
| Server-Sent Events (`/api/sse`) | Failed | Browser error: "EventSource's response has a MIME type (text/html) that is not text/event-stream". Root cause not diagnosed -- excluded from the fallback plan until fixed |
| File write/read | Confirmed | Round-tripped a file through `/api/file-write` and `/api/file-read` successfully -- relevant for Open Question #4 (buffer/retention storage) |
| Shell command execution | Confirmed (works) | Also an active, unauthenticated exposure today -- see security note below |

**Fallback cascade for push delivery (based on verified results):** WebSocket (primary) -> long polling (fallback if WS unavailable) -> chunked streaming (niche fallback). SSE excluded until the MIME-type issue is root-caused.

**Operational finding, update (2026-10-11, after extended live debugging):** The Infomaniak-hosted `poc-node` PoC is currently unreliable as a relay candidate for an unrelated reason: the public URL (`https://assistant.wadeck.ch`) intermittently serves Infomaniak's generic "under maintenance" page even when the Node app is confirmed healthy (verified repeatedly: `curl 127.0.0.1:3000/` returns `200 OK` with full content, PM2 shows a single clean process online, zero restarts, zero errors in logs). Ruled out with direct evidence: process crash, PM2 process name (tested both `infomaniak-test` and `server` -- both got the maintenance page while healthy), port conflicts, and the `pm2 start` vs `pm2-runtime` daemon-mode issue (separately found and fixed: `pm2 start` daemonizes and exits 0 immediately, which made Infomaniak's own platform supervisor think the app had died and restart-loop it -- fixed by switching to `pm2-runtime start ecosystem.config.cjs`, a real bug now fixed regardless of the maintenance-page issue). The remaining maintenance-page behavior is Infomaniak edge/platform-side and unexplained from the application side; raised as an open risk against using this host as the relay until resolved (ticket with Infomaniak support recommended before relying on this infra).

**Immediate security note (out of scope for this spec's design, but found during testing):** Infomaniak's hosting panel has its own platform-level supervisor for the Node.js app, configured with "Commande d'execution: npm start" and a fixed listen port (3000) -- independent of any PM2 process management done via SSH/CI. This is a second, separate control plane for the same process. If the platform's own `npm start`-triggered process and a CI-driven `pm2`-managed process end up using different PM2 process names, they fight over the same port/process (observed directly: a process named `server` -- PM2's default name derived from `pm2 start server.js` -- coexisted with the CI's expected `infomaniak-test` name, breaking the CI's restart/status checks for ~17 failed/stuck deploys). Fixed by aligning `package.json`'s `start` script and the CI's restart step to both resolve the process name from the same `ecosystem.config.cjs`. Worth re-verifying if Infomaniak ever changes its own supervision behavior.

**Immediate security note (out of scope for this spec's design, but found during testing):** `poc-node`'s live deployment at `https://assistant.wadeck.ch` exposes `/api/system-commands` (runs shell commands, returns `ls -la` of the server filesystem and `pwd`) and `/api/env` with zero authentication. This predates and is independent of this spec's decisions, but should be locked down before any production use of this host.

## Open questions

- See `_index.md` Open Questions #2, #3, #4.

## Security considerations

See `threat-model.md`. Key new surface: a public, currently-unauthenticated WebSocket endpoint (`poc-node`'s `/chat-ws` has zero auth today) must not ship to production for this use case without an auth/registration step added first.
