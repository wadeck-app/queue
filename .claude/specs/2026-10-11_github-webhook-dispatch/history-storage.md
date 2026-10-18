# History / Audit Storage -- GitHub Webhook Dispatch

**Version:** v0.1
**Last updated:** 2026-10-11
**Status:** Draft

## Overview

Where every webhook reception (verified or not) is recorded. Backs both the audit requirement (log everything, with source IP + content) and the "past events" query endpoint planned under Decision #4.

## Decisions

| # | Decision | Rationale | Date |
|---|---|---|---|
| 6 | Flat append-only JSON Lines log file. Rotated/evicted to stay within 180 days AND 50MB (oldest-first), whichever limit is hit first. | `_index.md` Decision #6 -- kept simple, no database. | 2026-10-11 |

## Design

One line per reception, appended regardless of HMAC verification result:

```
{ "receivedAt": "...", "source": "github", "webhookConfigId": "...", "sourceIp": "...", "verified": true, "eventType": "pull_request", "deliveryId": "...", "payload": { ... } }
```

Rotation/eviction: periodic sweep deletes entries older than 180 days, then deletes oldest entries further if total size still exceeds 50MB.

## Open questions

None currently.

## Security considerations

Contains raw payload content (private repo data per threat-model assets) and source IPs for every attempt, including invalid ones. No access-control boundary beyond file permissions on the relay host -- consistent with Decision #3 (no isolation between Consumers).
