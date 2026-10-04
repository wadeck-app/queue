# Events history command (`queue history`)

## Context

The user wants a `queue history` command, equivalent in spirit to a "flow history" command: an audit trail of which events were triggered and which subscribers listened (and with what outcome).

No "flow history" exists in this repo to copy. The closest existing thing is `queue logs`, which reads `<configDir>/logs/<date>.ndjson` (written by `EventLogger`, `src/storage/EventLogger.ts`) — today only, no filters, no `--json`.

Two gaps make the existing logs unsuitable as-is for a history view:

1. **Events with zero matching subscribers leave no trace.** `QueueDaemon.push` (`src/daemon/QueueDaemon.ts:96-177`) only logs `filter-miss` for subscribers that didn't match a `when:` filter, and `dispatch` entries per subscriber outcome. If an event has no subscribers configured at all, nothing is written anywhere.
2. **Successful sync (`before*`) dispatches are often not logged at all.** `SyncDispatcher.dispatch` (`src/dispatch/SyncDispatcher.ts:63-70`, `90-92`) only calls `logDispatch` on success when the subscriber's stderr was non-empty (intentional noise-reduction for the verbose debug log — not a bug to fix). A clean successful `before*` dispatch is invisible in `logs/`.
3. There's no `eventId` correlating the per-subscriber log lines of a single push, so grouping "this event push -> these subscribers -> these outcomes" from `logs/*.ndjson` alone is unreliable when the same event fires repeatedly in quick succession.

The user explicitly asked for a dedicated, lightweight journal "à côté des logs" (next to, not instead of, the existing verbose logs) to drive this command, rather than trying to repurpose the noisy debug logs. `.claude/out-of-scope.md` says "No database, no message store beyond `wal.ndjson` and `dlq.ndjson`" — but `logs/` is already an established exception to that (it's observability data, not a message store consumers replay from). A second, sibling observability directory for a terse journal is the same category of exception, not a new one. This will be called out to the user as a one-line doc update rather than silently stepped around.

## Design

### 1. New lightweight journal writer — `src/storage/HistoryLog.ts`

Mirrors `EventLogger`'s append-only NDJSON pattern, but writes to `<configDir>/history/<date>.ndjson` and only ever stores tiny structured facts — no stdout/stderr, no error text blobs:

```ts
export interface HistoryWriter {
  logTrigger(e: { eventId: string; event: string; project?: string; matchedCount: number; totalCount: number }): void;
  logOutcome(e: { eventId: string; event: string; subscriberId: string; status: 'success' | 'failed' | 'dlq' }): void;
  logFiltered(e: { eventId: string; event: string; subscriberId: string }): void;
}

export class HistoryLog implements HistoryWriter { /* same ensureDir/append pattern as EventLogger */ }
```

### 2. Wire it into the dispatch path

- `src/daemon/QueueDaemon.ts` push handler (~line 96): construct `historyLog` alongside the existing `eventLogger`. After subscriber resolution + `when:` filtering, call `historyLog.logTrigger({ eventId: envelope.id, event: req.event, project: envelope.meta.projectName, matchedCount: filtered.length, totalCount: subscribers.length })` — this is what makes "no subscribers matched" visible. Inside the filter loop, when `evaluation.matched` is false, also call `historyLog.logFiltered(...)`.
- `src/dispatch/AsyncDispatcher.ts` and `src/dispatch/SyncDispatcher.ts`: constructors gain a `historyLog: HistoryWriter` parameter (both already take `logger: QueueLogWriter` the same way — same pattern). Call `historyLog.logOutcome(...)` **unconditionally** at every success/failed/dlq branch, using `envelope.id` (already on `EventEnvelope`, no new field needed) — unlike `logDispatch`, this call is never gated by stderr/noise heuristics, so sync successes are no longer invisible to history.
- Update the two call sites in `QueueDaemon.ts` that construct `new AsyncDispatcher(...)` / `new SyncDispatcher(...)` to pass the new `historyLog` argument.

### 3. Read-model — `src/cli/HistoryReader.ts`

Reads `<configDir>/history/*.ndjson` across all available dates (entries are tiny, so reading the whole journal by default is cheap — unlike `logs/`), applies filters, and groups `trigger` + `outcome` + `filtered` records by `eventId` into:

```ts
interface HistoryEntry {
  ts: string;
  eventId: string;
  event: string;
  project?: string;
  subscribers: Array<{ subscriberId: string; status: 'success' | 'failed' | 'dlq' | 'filtered' }>;
  unmatchedCount: number; // totalCount - matchedCount - filteredCount, i.e. no subscriber configured at all
}
```

Filters: `event`, `subscriberId`, `status` (`success|failed|dlq|filtered`), `since` (epoch ms cutoff).

### 4. CLI command — `queue history` (+ `queue cli history` alias)

In `src/cli/QueueIndex.ts`, following the exact dual-registration pattern already used for `logs`/`cli logs` (lines ~592-596 and ~651-656):

- `queue history [--event <name>] [--subscriber <id>] [--status success|failed|dlq|filtered] [--since <Nd|Nh|Nm>] [--json]`
- `--since` uses Jira-style relative time (`-3d`, `-2h`, `-30m`): strip a leading `-` and reuse the existing `parseDuration` from `@wadeck-app/shared-cli/Duration` (already imported in this file for `--timeout`) rather than writing a new parser. Default: no cutoff (show everything in the journal) — since the journal is cheap to read fully, unlike `logs/`.
- Default (non-JSON) output: one line per trigger, newest first, with indented per-subscriber outcome lines, reusing the `[ok]/[fail]/[warn] dlq/[miss]` status-marker convention from `LogFormatter.ts` for visual consistency. New file `src/cli/HistoryFormatter.ts` for this, parallel to `LogFormatter.ts`.
- `--json`: prints the raw `HistoryEntry[]` array.
- Add `warnUnknownArgs(...)` call matching other commands, update `usage()` text (~line 73-91) and `CLI_GROUP_HELP` (~line 33-39).

### 5. Tests

- `src/storage/HistoryLog.test.ts` — write/read round trip, file-per-day naming.
- Extend `AsyncDispatcher`/`SyncDispatcher` existing test files to assert `historyLog.logOutcome` is called unconditionally on success (including the clean-stdout/no-stderr case that `logDispatch` currently skips).
- `src/cli/HistoryReader.test.ts` — grouping by `eventId`, all filter combinations, the "0 subscribers matched" and "all filtered" cases.
- Extend `QueueIndex.integration.test.ts` (or a new `HistoryCommand.test.ts`) — push an event with one matching + one filtered subscriber, run `queue history --json`, assert the shape.

### 6. Docs

- One-line addition to `.claude/product-vision.md` current-state command list: add `history`.
- One-line clarification in `.claude/out-of-scope.md`'s "Persistent storage beyond WAL and DLQ" section: note that `logs/` and `history/` are observability directories, not message stores, and are not covered by that restriction — flagged to the user for approval since it's a documented boundary, not silently reinterpreted.

## Verification

- `npm test` (or project's existing test command) covering the new/updated test files above.
- Manual run: start daemon (`queue start`), `queue sub add test.hello --type cli --command "echo ok"`, `queue push test.hello '{}'`, then `queue push test.hello '{}' ` with a `when:` filter that misses, then `queue history` and `queue history --json --status filtered` to visually confirm both the matched and filtered rows render correctly, and `queue push unconfigured.event '{}'` to confirm a 0-subscriber trigger still shows up.
