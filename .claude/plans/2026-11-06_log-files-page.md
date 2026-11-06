# Queue "Log files" page (size, date, prune)

Request: a page in app-module-queue listing the log files (size, date) with actions to prune. Retention exists (`queue-core/src/storage/LogRetention.ts`: logs 90 d / 100 MB, history 90 d / 200 MB, run only when a new day's file is created).

## Decisions

| # | Decision |
|---|---|
| 1 | One shared implementation of the policy: `LogRetention` gets a pure `collect()`/`plan()`; `pruneLogDir` = plan + unlink; a `dryRun` option and `listLogFiles` reuse the same plan, so the preview cannot drift from the real deletion (test: dry run and real prune on identical trees give the same files and reasons). |
| 2 | Additive queue-core API: `listLogFiles`, `dryRun`, `deleteLogFile(dir, { kind, day, variant }, { keepDay })`, `statQueueFiles(configDir)` (wal/dlq info only). ENOENT on unlink counts as success ("already gone"). A missing directory is an empty listing, not an error. |
| 3 | Actions: "Prune by policy" per directory (the server recomputes the plan at execution time, never trusts the preview) and "Delete this file" per row (allowed on files still within retention). No "older than N days" input in v1. |
| 4 | Safety: the client sends `kind` (logs\|history), `day` (a real YYYY-MM-DD date) and `variant` (daemon\|launcher), never a path; the name is built server-side. Today's file (UTC, same clock as the loggers) is refused with 409. Extra guard for launcher logs: also refuse a file modified in the last 24 h (the Go launcher's day boundary may be local time: unverified). `wal.ndjson`, `dlq.ndjson`, `subscribers.yml`: no route, no code path (info rows only). |
| 5 | Report, never throw: per-file failures come back in the body (200) with the existing `fix` text; 500 only when a directory exists but cannot be read. |
| 6 | Report persistence: the POST returns the report; the page shows the last prune from an in-memory `lastPrune` (lost at restart, documented). No diagnostic written to the day log from the module. |
| 7 | History confirm text says that events of the deleted days can no longer be replayed. Days are labelled UTC. |
| 8 | Mutating routes take a JSON body for the policy prune (a cross-site simple form cannot send it without a preflight; app-core CORS behaviour unverified). No new auth: the threat-model clause "revisit only with auth/CSRF from app-core" applies; accepted risk = loss of old logs and history only. |

## Amendments after review (override the text above where they conflict)

| # | Amendment |
|---|---|
| R1 | The Go launcher names its file with LOCAL time (`go-launcher/logger.go:40`), the daemon with UTC. Protected = any day >= UTC today (future included) and, for launcher files, the host's local today and local tomorrow; plus a 1-minute mtime guard for every kind, and the 24 h mtime guard for launcher files. A `protectedReason` (today UTC / today local / future / recently modified) is returned. Day labels: "UTC" for daemon logs and history, "local" for launcher logs. |
| R2 | Windows: the Go launcher keeps its log open and may not allow deletion (EBUSY/EPERM). The failure `fix` text for the dashboard says the file is held open by the running launcher and is released at the next local day or after `queue stop`; test with a failing-unlink seam. The daemon-oriented `fix` of LogRetention stays for the daemon path. |
| R3 | ENOENT on unlink AND on stat counts as success ("already gone") inside the shared code, so the daemon (midnight race with the dashboard) gets no false warning. Test: the file disappears between readdir and unlink. |
| R4 | One shared `parseLogDay()` with a round-trip check (`new Date(ms).toISOString().slice(0,10) === day`) used by listing, `canDelete` and the delete route (V8 rolls `2026-02-30` over to March). Tests: 2026-02-30, 2026-13-01, 2026-00-10, 0000-01-01. |
| R5 | A body-less POST is not protected by the JSON-body argument. The new mutating routes reject a browser cross-site request: 403 when `Sec-Fetch-Site` is `cross-site` or `same-site`; accept `same-origin`, `none`, absent (curl, CLI, tests). A shared guard function, tested. Existing mutating routes (push, replay, retry, dlq clear, give-up) are NOT changed in this work: offered to the user as a follow-up. Keep `isRecord(body)` strict on the prune body. Threat-model wording corrected accordingly. |
| R6 | The toast shows only `message` (success, overrides `successMessage`) or `error`/`message` (failure). Both POST responses carry a `message` string (counts, freed size, files that could not be deleted); failures put the actionable text (error + fix) in `error`. A delete of an already-gone file is an idempotent 200 `deleted:false, message: "already gone"`; 404 only for an invalid combination (history + launcher). |
| R7 | Prune routes: `POST /log-files/:kind/prune` (kind in the URL, no body needed); the page uses two actions with literal URLs. Delete actions are separate per section (`deleteLogsFile`, `deleteHistoryFile`) because `confirm:` is a static string; the history one says: deleted days lower Overview/Activity counters, events whose trigger was in a deleted day but whose retries survive become orphans (replay answers "No payload recorded", 422), other events can no longer be replayed. Success `message` names the file. |
| R8 | Row `id` is unique (`logs:2026-10-24:launcher`); URL placeholders come from separate primitive fields `kind`, `day`, `variant` (percent-encoded by the shell). Row action visibility uses `condition: canDelete` (no per-row `$if`/`disabled` exists); the server enforces regardless. |
| R9 | DSL facts: `format: bytes` exists for table columns (send raw `bytes`; keep `sizeText`/`totalText` for stat tiles and prose); `Progress` with `value`, `max`, `variant`, `valueLabel` ("64 MB of 100 MB"); `successMessage` is static; `reloadSources: true` explicit. The installed devDependency bundle (2026.10.24) lacks `ActionButton`; the running app-core is newer: validate against the real server and add a "needs dsl-ui >= ..." comment like logs-page.yaml. |
| R10 | Reverse decision 6: each delete or prune writes ONE diagnostic line through EventLogger (`source: 'LogFilesPage'`) as an audit trail (the in-memory `lastPrune` is lost at module reload). Accepted side effect: the module process may create today's file and trigger retention (same policy, harmless). |
| R11 | `pruneLogDir` cannot be a pure plan (the size pass depends on which age deletions failed). `dryRun` runs the same function with a recording `remove` seam that pretends every deletion succeeds; the equivalence test (dry run vs real prune on an identical tree) holds when no unlink fails; separate tests cover failure + size pass. `LogFile` gets `mtimeMs`. |
| R12 | `deleteLogFile`: `lstat`, require `isFile()` (a directory named like a log is refused), assert `dirname(resolved) === dir` and the basename against the same pattern. The echoed bad value in a 400 is truncated. The new `kind`/`variant` messages are new wording (only `date must be a day...` exists today). |
| R13 | Tests added: Sec-Fetch-Site guard, future-dated and local-today launcher protection with an injected clock and `TZ`, `EBUSY` message, ENOENT races (daemon and dashboard), missing and unreadable directory, non-matching file not listed, `message` present in both POST responses, page test (condition keys, `format: bytes`, unique ids, action names/URLs equal registered routes, history confirm mentions replay), real-server traversal set (`%2F`, `%252F`, `%5C`, `%00`, very long segment, 2026-02-30, unknown kind, history+launcher) with a sentinel file outside untouched. Delete a history day then check `findByEventId`, `read()`, replay behave as documented. Docs: also `docs/subscribers.md` retention paragraph. |

## Routes (registered after `GET /logs`, static before parameterised)

| Route | Request | Response | Status |
|---|---|---|---|
| `GET /log-files` | none | `{ today, sections: [{ kind, label, exists, maxAgeDays, maxTotalText, totalText, usageText, usagePercent, prunableCount, prunableText, warning?, files: [{ id, name, day, variant, bytes, sizeText, modifiedMs, status: today\|kept\|prune, statusText, canDelete }] }], queueFiles: [...], lastPrune? }` | 200; 500 if a directory exists but is unreadable |
| `POST /log-files/prune` | `{ kind }` | `{ kind, deleted[], failures[], freedBytes, freedText, remainingBytes, warning? }` | 200; 400 bad body/kind; 500 unreadable |
| `POST /log-files/:kind/:day/:variant/delete` | none | `{ deleted, file, bytes }` | 200 (also already gone); 400 invalid kind/day/variant; 404 no such file; 409 today / recently modified; 500 unlink failed with `{error, fix}` |

Messages follow the existing wording (`kind must be one of logs, history, got: "x"`, `day must be a day as YYYY-MM-DD, got: "..."`). New typed errors `LogFileNotFoundError` (404), `LogFileInUseError` (409) in `errors.ts`; business code in `src/backend/logFiles.ts`.

## Page

`src/dsl-views/log-files-page.yaml`, path `/log-files`, 9th nav entry after "Queue Logs". Header, a warning card when needed, one section per directory (usage line, StatTiles, "Prune by policy" button shown only when something would be pruned, DataTable file/day UTC/size/modified/status/delete action), info rows for wal/dlq, the last prune card. Static `confirm:` texts; row actions disabled for today's file (server enforces regardless). DSL unknowns to settle by running app-core: per-row `$if` on actions, several row keys in an action URL, bytes formatting (the backend sends `sizeText`).

## Steps (each leaves the tree green)

1. queue-core: collect/plan refactor, `dryRun`, `listLogFiles`, `statQueueFiles`, ENOENT = success; tests incl. dry-run vs real prune equivalence.
2. queue-core: `deleteLogFile` (strict validation, today/recent refusal, traversal impossible) + tests.
3. Module backend `logFiles.ts` + errors + unit tests.
4. Routes in `index.ts` + `backend.test.ts` (route list asserted in order, mocks, status mapping).
5. Page yaml + manifest entry + `logFilesPage.test.ts` + navigation test; run in app-core and settle the DSL unknowns.
6. Real-server integration test (extend `call` with a body): list, delete old, today 409, traversal not 200 and a sentinel file outside untouched, unknown kind 400, policy prune removes only old files.
7. Docs: root CLAUDE.md (route list, 9 pages, "pruning log files"), `.claude/out-of-scope.md` GUI sentence, `.claude/threat-model.md` (dashboard exposure, mutating routes, retention bullet), `npm run check` and `npm run bundle`.

## Out of scope

Pruning WAL/DLQ, an N-days input, writing a diagnostic line from the module, auth/CSRF.
