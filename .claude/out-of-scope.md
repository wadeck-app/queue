# Out of Scope — queue

## Message broker / distributed queue

This is a single-machine local daemon. No cross-machine event routing, no pub/sub over a network, no persistent broker.

## Event ordering guarantees

Events are dispatched in submission order within a single push, but cross-push ordering is not guaranteed. No ordered delivery or message sequencing primitives.

## Event deduplication

No deduplication by content or event ID. The same event pushed twice results in two independent dispatch chains.

## Subscriber authentication / authorization

Subscribers are defined in `subscribers.yml` files on the local filesystem. No auth model for who can register or receive events.

## Event schema validation / contract enforcement

The queue delivers `payload: unknown` as-is. Payload structure is the subscriber's responsibility. The queue does not validate payload shape against a schema.

## GUI / dashboard

This is a CLI-only tool. No web dashboard is planned for queue. See `orchestrator` for dashboard patterns if needed.

## Cross-platform daemon management (launchd, systemd)

`@wadeck-app/singleton-daemon-kit` handles the daemon lifecycle. The queue does not add its own service management layer.

## Persistent storage beyond WAL and DLQ

No database, no message store beyond `wal.ndjson` and `dlq.ndjson`. The WAL is not a general-purpose event log for consumers to read from.

`logs/<date>.ndjson` (verbose per-dispatch debug trail, `EventLogger`) and `history/<date>.ndjson` (terse trigger/outcome/filtered audit trail for `queue history`, `HistoryLog`) are observability directories, not message stores: they are written for humans to read (via `queue logs`/`queue history`), not consumed by subscribers or replayed as a delivery mechanism. They are not covered by this restriction.

## HTTP subscriber webhook security (HMAC, TLS client cert)

Subscribers of type `http` receive events as plain HTTP requests with configurable headers. No signing, no mutual TLS. Callers are responsible for adding auth headers in the subscriber config.
