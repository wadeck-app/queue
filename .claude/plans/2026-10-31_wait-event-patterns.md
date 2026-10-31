# `queue wait` event patterns

Request: a wait on `dep.published.*` without listing every name (also covers names added later). Same syntax as `subscribers.yml`.

## Decisions

| # | Decision |
|---|---|
| 1 | A target is a pattern when a segment is exactly `*` or `>` (`**` is rejected by `queue wait`, exit 4, pointing to `>`: NATS/Solace/ActiveMQ convention; `EventMatcher` still accepts `**` as an alias for subscribers.yml). Matching reuses `EventMatcher` (single source of truth with `subscribers.yml`). |
| 2 | `HistoryReader` filter stays exact (used by `queue history`, the dashboard). Pattern filtering lives in the wait layer: read once per poll, filter by `EventMatcher`. |
| 3 | Patterns skip the catalog declaration check (a pattern is never "declared"). Instead: warn `[warn] no known event matches "<pattern>"` when no declared or seen name matches. `--strict` does not refuse a pattern (names may come later). |
| 4 | Timeout `lastSeenAt` for a pattern = latest `lastSeenAt` among matching names (null if none). Messages already quote the pattern. |
| 5 | Relay detection (`isRelaySourcedEvent`) unchanged: `on.github.*` matches its regex, `on.>` does not (documented, not special-cased). |
| 6 | `queue events register` unchanged: declared names stay concrete (`NAME_PATTERN`). |
| 7 | The matched entry already carries the concrete `event` in the result; no new field. |

## Amendments after review

| # | Amendment |
|---|---|
| A1 | Reuse `listEvents(configDir, { nowMs, match })` for "any known event matches" and for `lastSeenAt` (max over non-null, list is not time-sorted). |
| A2 | Malformed pattern (a segment containing `*`/`>` that is not exactly `*` or `>`; `**`; empty segment; `>` not last) fails at parse: exit 4, actionable message. |
| A3 | Relay: a pattern starting with `on.` starts the relay (exact names keep the regex); relay patterns skip the "no known event" warning. Bare `>`: `[info]` that the relay is not started. |
| A4 | Pattern targets: no `declared`/`suggestions` in `--json` (documented, pinned by test); multi-target timeout JSON adds `pattern: true`. |
| A5 | `readEntries` for patterns calls `reader.read({ sinceMs })` and filters by `EventMatcher`, excluding orphan `(unknown)` entries. |
| A6 | Timeout wording for patterns: `no event matching "<p>" in the last 7 days` / `last matching event "<name>" at <ts>` (add optional `lastSeenEvent` in JSON), suggest `queue events list --match "<p>"` (verify the flag exists). |
| A7 | Empty catalog + no history: pattern warning is a softer `[info]` (mirror `catalogEmpty`). |
| A8 | Help/docs: double-quoted examples, shell redirect/glob warning, `--all` = each pattern target satisfied by any one name, `--strict` does not refuse patterns. |
| A9 | Extra tests: `dep.>` vs `dep`, `dep.*` vs `dep.a.b`, `--since`, `--when`, pattern+exact in one wait (any/all), relay patterns, malformed exit 4, empty catalog, orphan vs `>`. |

## Changes

1. `queue-core`: `isEventPattern(s)` next to `EventMatcher`; export both from `src/index.ts`; unit tests (`EventMatcher.test.ts`).
2. `queue-cli/waitCli.ts`: `readEntries` filters by `EventMatcher` for pattern targets, exact fast path otherwise; skip declaration check for patterns and warn per decision 3.
3. `queue-cli/eventWaitCatalog.ts`: `lastSeenAtOf` pattern-aware; new `patternMatchesKnownEvent` helper (declared or observed names via `listEvents`).
4. Tests: `waitEventCatalog.test.ts` (real history; `*`, `>`, no match timeout, `--strict` not refusing, mixed exact+pattern, `--all`), `eventWaitCatalog.test.ts` (helpers).
5. Docs: `WAIT_HELP`, `QueueIndex.ts` usage line, `docs/wait.md`, `README.md`, `packages/queue-sdk/docs/reference.md:82` (says exact match). Quote patterns in examples (`>` is a shell redirect, `*` globs).
6. Outside repo: poll-event skill lines about "exact name" (report to the user, not edited here).

## Out of scope

Partial-segment wildcards (`foo*`); regex; pattern support in `queue wait ci`.
