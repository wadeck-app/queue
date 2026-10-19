# Out of Scope — queue

## Message broker / distributed queue

This is a single-machine local daemon. No cross-machine event routing, no pub/sub over a network, no persistent broker.

**Carve-out:** `packages/queue-relay-client` (+ per-Source plugins like `packages/plugin-github`) makes Queue a *consumer* of one external push source (a GitHub/Slack/Jira webhook relay) — it does not turn Queue's own daemon into a distributed broker. No daemon-to-daemon routing is added; the relay client is just another local process calling the existing `push` RPC, same as the CLI or `app-module-queue` already do.

## Event ordering guarantees

Events are dispatched in submission order within a single push, but cross-push ordering is not guaranteed. No ordered delivery or message sequencing primitives.

## Event deduplication

No deduplication by content or event ID. The same event pushed twice results in two independent dispatch chains.

## Subscriber authentication / authorization

Subscribers are defined in `subscribers.yml` files on the local filesystem. No auth model for who can register or receive events.

## Event schema validation / contract enforcement

The queue delivers `payload: unknown` as-is. Payload structure is the subscriber's responsibility. The queue does not validate payload shape against a schema.

## GUI / dashboard

queue has no dashboard of its own: `packages/app-module-queue` is a module of app-core's dashboard (status, DLQ, subscribers, history, logs, relay, activity). It reads the queue files and may replay, retry, clear a DLQ entry and push; that is all. It never edits `subscribers.yml` and never starts or stops a daemon: those stay `queue sub`, `queue start|stop` and `queue relay start|stop` (see the threat model, "Dashboard exposure").

## Cross-platform daemon management (launchd, systemd)

`@wadeck-app/singleton-daemon-kit` handles the daemon lifecycle. The queue does not add its own service management layer.

## Persistent storage beyond WAL and DLQ

No database, no message store beyond `wal.ndjson` and `dlq.ndjson`. The WAL is not a general-purpose event log for consumers to read from.

`logs/<date>.ndjson` (verbose per-dispatch debug trail, `EventLogger`) and `history/<date>.ndjson` (terse trigger/outcome/filtered audit trail for `queue history`, `HistoryLog`) are observability directories, not message stores: they are written for humans to read (via `queue logs`/`queue history`), not consumed by subscribers or replayed as a delivery mechanism. They are not covered by this restriction.

## HTTP subscriber webhook security (HMAC, TLS client cert)

Subscribers of type `http` receive events as plain HTTP requests with configurable headers. No signing, no mutual TLS. Callers are responsible for adding auth headers in the subscriber config.
