# Threat Model -- GitHub Webhook Dispatch

**Version:** 1.0
**Date:** 2026-10-11
**Methodology:** STRIDE

## Scope

The relay service (Node.js/Fastify on Infomaniak) that receives GitHub webhook POSTs on a public endpoint and forwards them over WebSocket to Queue running on the local machine, plus Queue's local dispatch to agents.

## Assets

What we are protecting:

| Asset | Sensitivity | Owner |
|---|---|---|
| GitHub webhook payload content (PR data, repo metadata) | Medium -- not secret, but reveals private repo activity if repos are private | User |
| WebSocket endpoint on the relay | High -- currently has zero auth (poc-node baseline); anyone who finds the URL can connect | User |
| GitHub webhook secret (for HMAC verification) | High -- compromise allows forged events | User |

## Threat actors

| Actor | Motivation | Capability |
|---|---|---|
| Opportunistic scanner | Finds the public endpoint by chance/scanning, probes for open WebSocket/HTTP endpoints | Low -- no targeted knowledge, automated tools |
| Malicious actor with endpoint URL | Sends forged "GitHub" events to trigger unwanted local agent actions | Medium -- needs the URL, no auth today to stop them |

## STRIDE analysis

### Spoofing
Open: nothing today stops a third party from POSTing a forged "GitHub" webhook to the relay, or connecting to the WebSocket pretending to be Queue. Mitigation plan depends on Open Questions #2 (Queue auth) and #3 (webhook HMAC verification) in `_index.md`.

### Tampering
*(pending -- add decisions that affect data writes and transit)*

### Repudiation
*(pending)*

### Information Disclosure
*(pending -- add decisions that affect data exposure and access control)*

### Denial of Service
*(pending)*

### Elevation of Privilege
*(pending)*

## Mitigations

| ID | Threat category | Threat description | Mitigation | Status | Decision # |
|---|---|---|---|---|---|
| T-01 | Spoofing | Forged webhook payload sent directly to the relay's public endpoint | HMAC signature verification (`X-Hub-Signature-256`) against the GitHub webhook secret | Open | - |
| T-02 | Spoofing / Elevation of Privilege | Unauthenticated third party connects to the relay's WebSocket as if it were Queue | Random high-entropy API token (256-bit), relay stores only `SHA-256(token)` with constant-time comparison. Protects the relay's credential store at rest; does not protect a token leaked in transit or from Queue's local storage (accepted residual risk for a single-tenant-per-token model). See `auth.md`. | Mitigated | 2 |
| T-03 | Information Disclosure | Webhook payloads (private repo PR data) stored or logged on the relay without access control | Access control is enforced at authentication only (Decision #2's per-Consumer token keeps unauthenticated strangers out entirely). By explicit design (Decision #3), there is no isolation *between* authenticated Consumers -- all Consumers belong to the same owner and can see/configure all WebhookConfigs. Implemented: any authenticated Consumer (not just the admin) can read `/api/webhook-history`, matching this design. | Mitigated | 2, 3, 6 |
| T-04 | Information Disclosure | WebhookConfig secrets (used for HMAC verification) are stored in plaintext in `webhook-configs.json`, not hashed. | Necessary trade-off, not a gap: HMAC verification requires the relay to recompute the signature itself, which is only possible with the plaintext secret -- a hash cannot be used here the way Consumer tokens are hashed (Decision #2). Mitigation is file-permission hygiene on the relay host (same exposure class as `consumers.json`/`webhook-history.jsonl`), not cryptographic. | Accepted (inherent) | 3 |

## Open security questions

<!-- Security findings that feed into _index.md open questions.
     Format: Q: <question> -> see Open Questions #N in _index.md -->
