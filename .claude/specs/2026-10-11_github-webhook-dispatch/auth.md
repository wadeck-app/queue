# Client Auth -- GitHub Webhook Dispatch

**Version:** v0.1
**Last updated:** 2026-10-11
**Status:** Draft

## Overview

How Queue authenticates to the relay's WebSocket endpoint. Does NOT cover GitHub-to-relay webhook authentication (HMAC signature verification), which is a separate concern tracked under Open Question #3.

## Decisions

| # | Decision | Rationale | Date |
|---|---|---|---|
| 2 | Random high-entropy API token; relay stores only a hash of it, never the plaintext. | Chosen over 7 other candidates (see `_index.md` Decision #2) because the relay is public and multi-tenant -- protects the relay's credential store at rest for near-zero extra implementation cost over a plain bearer token. | 2026-10-11 |

## Design

### Token generation
- Generated once, server-side, at registration time (not chosen by the user -- a human-memorable value defeats the point of a high-entropy token).
- Minimum 256 bits of entropy (e.g. 32 random bytes, base64url-encoded) -- large enough that brute-forcing it is infeasible regardless of hash speed.
- Given to the user/Queue exactly once at creation time; the relay never displays or logs the plaintext again after that.

### Storage
- Relay stores `SHA-256(token)` only, never the plaintext.
- Deliberately NOT bcrypt/argon2/scrypt: those exist to slow down brute-forcing a *low-entropy* human password. A 256-bit random token is already infeasible to brute-force, so a slow hash only adds unnecessary CPU cost on every request with no security benefit.

### Verification
- On each connection, Queue sends the plaintext token (over TLS, which the relay already terminates).
- Relay hashes the received token with SHA-256 and compares against the stored hash using a **constant-time comparison** (e.g. Node's `crypto.timingSafeEqual`) -- a naive `===`/`==` string comparison leaks timing information that can be exploited to recover the hash byte-by-byte.

### What this protects against
- A leak of the relay's credential store (e.g. a backup, a misconfigured database export, a compromised admin account) exposes only hashes, not usable tokens.

### What this does NOT protect against (accepted, matches the chosen trade-off)
- A token intercepted in transit (TLS compromise) or leaked from Queue's local storage is directly usable until rotated -- same residual risk as a plain bearer token. If this risk needs closing later, revisit Option C (app-layer signature auth) from the original comparison.

## Implementation (poc-node)

Implemented in `C:\Workspace_Other\poc-node\lib\consumers.js`, wired into `server.js`. Realizes Decision #2 concretely as named Consumers (`{ username, tokenHash, createdAt, isAdmin }` in `consumers.json`), with a username+PIN claim flow:

- An already-authenticated session calls `POST /api/consumers { username }`, which reserves the username and generates both a token and a 6-digit PIN server-side. Only the PIN is returned to that session -- the plaintext token is never shown there.
- The new client claims it via the public `POST /api/consumers/claim { username, pin }` (5-minute expiry, constant-time PIN comparison), receiving the plaintext token exactly once.
- A pre-existing single-global-token deployment (the old `auth-token-hash.json`) migrates automatically into one Consumer named `admin` with `isAdmin: true` -- satisfies "add a username to the token too, including the first one" without requiring a manual migration step.
- Login (`POST /api/login`) now scans all Consumers' hashes rather than comparing against one global hash.
- WebSocket Consumers (`/relay-ws`) authenticate via a `{ type: "auth", token }` first message rather than the browser session cookie, since non-browser clients (like a future Queue plugin) have no cookie.

Verified end-to-end locally: setup -> login -> consumer creation -> PIN claim -> WS auth -> subscribe, all behaving as designed (see plan verification section).

## Open questions

None currently -- revisit if the relay's trust model changes (e.g. becomes genuinely multi-tenant with untrusted third-party clients, not just "public but still only Queue instances the user controls").

## Security considerations

See `threat-model.md` T-02. Mitigates Spoofing/Elevation of Privilege for the credential-store-leak scenario specifically; does not change the residual risk of a token leaking from Queue's own local storage or in transit.
