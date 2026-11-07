# `queue.dlq.added` / `queue.dlq.removed` events

Request (flow-test, user-approved): a refused or failed dispatch must be visible where users look; queue emits facts, subscribers decide (e.g. label a task). Principle: queue stays domain-agnostic (`guiding-principles.md`).

## Decisions (user)

| # | Decision |
|---|---|
| 1 | Always emitted: the presence or absence of a subscriber never changes which events exist. |
| 2 | No payload copy: the event carries a REFERENCE to the base event; the base payload must be easy to get (lazy loading). |
| 3 | Nested paths in `cli` templates: yes (backward compatible). |
| 4 | Symmetric event `queue.dlq.removed` in v1. |
| 5 | Plenty of tests. |

## Design

**`queue.dlq.added`** payload (facts only): `entryId`, `eventId` (base event), `event`, `subscriberId`, `projectId?`, `reason` (`retries-exhausted` \| `permanent-failure` \| `invalid-configuration` \| `given-up`), `error` (capped 500 chars), `attempts`, `exitCode?`, `target?`, and `original: { "$eventRef": "<eventId>" }`.
**`queue.dlq.removed`** payload: `entryId`, `eventId`, `event`, `subscriberId`, `projectId?`, `reason` (`replayed` \| `cleared`), `original` ref.

**Lazy reference**: `{ "$eventRef": "<eventId>" }` is a payload convention. When a template placeholder path walks into such an object, the runtime loads the base event from the history (`HistoryReader.findByEventId`) and continues the walk into ITS payload: `{{ payload.original.taskId }}` is the `taskId` of the base event. Loaded only when a placeholder needs it. If the base event is gone (history retention) the delivery fails permanently with an actionable message (what was referenced, retention is 90 days, use the data you need before). Also easy by hand: `queue history --event-id <id> --json` (add if missing), dashboard history/DLQ rows.

**Nested paths (cli templates)**: `{{ payload.a.b }}`: an own key literally named `a.b` wins (existing behaviour), otherwise walk own properties (never `__proto__`/`constructor`/`prototype`); refs resolved as above. Action templates already walk nested paths and get the ref resolution too.

**Where emitted**: wherever an entry enters or leaves the DLQ, including operations done outside the daemon: daemon (retries exhausted, permanent, invalid configuration; in-process), CLI `queue dlq clear|replay`, dashboard (`dlq/:id/clear`, `pending/*/give-up`, `dlq-replay`). Operations running outside the daemon complete first, then push the event to the daemon; when the daemon cannot be reached the operation still succeeds and the message says the event could not be sent (loud, never silent).

**Loop and noise guards**: no `queue.dlq.*` event about an entry whose base event name starts with `queue.` (a subscriber failing on `queue.dlq.added` must not produce another); hop counter applies (emitted events carry `hops+1` of the failing dispatch); `before*` never involved; projects: attributed to the failing dispatch's project (default direction). The base event name is never rewritten.

**Catalog**: both events declared by queue at daemon start (source `queue`) with schemas and the ref convention.

## Amendments after review (override the text above where they conflict)

| # | Amendment |
|---|---|
| A1 | Paths in/out of the DLQ: daemon (`dlqMover` in AsyncDispatcher: retries exhausted, permanent, `failConfig`), CLI `queue dlq clear\|replay` (already inside the daemon through RPC), dashboard clear and give-up (single and stuck) which write files WITHOUT the daemon, and the DLQ cap eviction (`DlqStore.append` drops the oldest at 1000): eviction emits `removed(evicted)`. Emission lives in one core function; the module uses a new NARROW daemon RPC `dlq-notify { kind, entries }` (never `push`, so it cannot forge `queue.*`), and when the daemon is unreachable the operation still succeeds with a loud message. |
| A2 | `DlqStore.append` becomes idempotent on id (replace, report `inserted`); `added` only when the row is new; `remove`/`clear` return the removed entries (read under the same lock); `retry` refuses a WAL entry already `acked` or `dlq`. A replay that fails again gives `removed(entryId E)` then `added(entryId E)`: documented, not a double emit. `removed(replayed)` is emitted only once the replay dispatch really started; the two early-return branches of `dlq-replay` (config fails, subscriber renamed) emit it but log that the entry is stuck (and are fixed in their own commit to fail loudly). |
| A3 | `eventId` of the reference is `entry.meta.eventId` (the WAL id has no trigger). Legacy entries without it: no `eventId`, `original: { "$eventRef": null }`, never a guessed id. Error text uses the real limits: the history keeps at most 90 days AND 200 MB. |
| A4 | Ordering: emit after `dlq.append` and before `wal.updateEntry('dlq')`, inside `activeDispatches` accounting; at-least-once (a crash in between gives a duplicate, never a loss), the idempotent append prevents a re-emit on the retry. Emitted with `hops+1` and `causedBy {eventId, subscriberId}`; at the hop cap the event is NOT dropped silently: a diagnostic is logged. Exclusion: no `queue.dlq.*` event about an entry whose base event name starts with `queue.` (documented as a decision). No per-second cap (it would break "always"); clear-all emits `removed` in a bounded-concurrency batch (10 at a time) after the clear returns. |
| A5 | Lazy ref, security (forged `{"$eventRef"}` from a wire payload would read another event's payload): refs are resolved ONLY when `meta.origin === 'queue'` (an internal meta flag set by `pushInternal` for the daemon-built events, never from the wire), the event is exactly `queue.dlq.added` or `queue.dlq.removed`, the ref sits at the top-level key `original`, one level only (never inside a resolved payload); the resolver returns only the payload and event name. The `queue.` namespace is RESERVED on every external entry: wire `push` is rejected, `emit` action names refused at load time, `register-events` source `queue` rejected from the wire, `queue replay` of a `queue.*` trigger refused; documented as protocol 1.5.0 (MINOR with a History row, daemon-built events only) in docs/push-protocol.md, `queue-sdk/src/protocol.ts` and the contract JSON. |
| A6 | Resolver implementation: injected from QueueService into BOTH dispatchers (and the action context for `emit`), memoized per dispatch, `substituteToken` stays pure (callback parameter), `walkPayloadPath` shared with `renderActionTemplate`; load-time rejection of `__proto__`/`constructor`/`prototype` segments for cli; a terminal `{{ payload.original }}` renders the ref JSON, never the payload. Cheap lookup: `HistoryReader.findTrigger(eventId)` scans day files newest first, byte-needle `"type":"trigger","eventId":"<id>"`, parses only the hit line (measure on a large generated history); `findByEventId` reuses it; `queue history --event-id <id>` added. Lazy resolution applies to TEMPLATES only (not `when:`, not http bodies, not stdin): documented. Nested rule: whole dotted key first, then walk own properties; a dotted key below level one is not tried (documented); `{{ a.b }}` against `{a:{b:1}}` used to render empty and now renders 1 (documented, regression test with `{"a.b":"x","a":{"b":"y"}}` giving x). |

## Implementation batches (each verified and committed before the next)

1. Storage hardening + cheap history lookup + nested paths (review sequence 1-3).
2. Reserved namespace + protocol 1.5.0 + `meta.origin` + ref resolution (4-5).
3. Event builders, daemon hook, catalog declaration, `removed` incl. eviction and replay (6-7).
4. Out-of-daemon paths (`dlq-notify`, module routes) + docs + threat model + real-daemon test (8-9).

## Tests

Unit: ref resolution (found, missing after retention, nested, own dotted key wins, `__proto__`), cli nested paths, event builders (reason mapping, error cap, no payload copy asserted by absence of any base payload key). Daemon: emitted with NO subscriber (history holds the event), for each reason, `queue.` origin excluded, hop cap, project attribution, retry exhaustion → one added, replay → removed then (on new failure) added again. Loop test: a subscriber that always fails on `queue.dlq.added` produces no event storm. CLI/dashboard: clear/give-up/replay push the event, daemon down → operation succeeds and message says so. Real daemon (isolated QUEUE_CONFIG_DIR + XDG): failing cli subscriber → `queue wait queue.dlq.added`, a template subscriber using `{{ payload.original.<field> }}` receives the base field, `queue dlq clear` → removed.

## Docs

`docs/subscribers.md` (events, ref convention, nested paths), `docs/push-protocol.md` (reserved `queue.` namespace, wire unchanged), threat model (event carries no payload), `README`/CLAUDE.md event list if any.
