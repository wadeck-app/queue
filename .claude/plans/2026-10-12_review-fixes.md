# Review fixes: relay client, daemon wake, app-module, history CLI

Status 2026-10-12. Evidence tags: **R** = reproduced by running the installed bundle (`queue-cli` 2026.10.12-096-af58ee68 = HEAD af58ee6) or the repo's built `dist` in an isolated `QUEUE_CONFIG_DIR`; **C** = confirmed by reading code (file:line); **I** = inferred from JS/Node semantics only.

Test method: `node <global>/@wadeck-app/queue-cli/queue.cjs ...` (the `queue` shim's Go launcher returned empty output through a pipe, cause not investigated). Probe scripts: `/tmp/qprobe/`. Leftover test files are listed in `/tmp/qtest_cleanup_list.txt` (not deleted: the rm guardrail blocked it).

## Corrections to earlier reviews

| Earlier claim | Verdict |
|---|---|
| `relay start` prints `[ok]` even with an invalid `relay.yml` | **Wrong (R)**. An invalid YAML gives `[fail] ... within 5s` with no cause. The `[ok]` case is a missing `relay.yml` (R, 1.4). |
| `relay start` ends in an uncaught stack trace in a published install | Softer (R): `[queue] Fatal error: Cannot find module '@wadeck-app/queue-relay-client/dist/relay-daemon-entry.js'`. Still not actionable. |
| `offset=-3` returns the last entries | Wrong (R): returns 0 entries. `limit=-5` returns 989 of 994 as predicted. |
| Missing `docs/windows-hidden-process.md` | Not a bug: global doc, dropped. |
| Threat model lacks relay coverage | Wrong (C): `threat-model.md:55-59`. Only private repo data / payload size is missing (minor). |
| Duplicate daemons crash or collide | Wrong (C): startup lock + takeover serialize them. R: 5 concurrent wakes spawned 5 processes (5 `.vbs`), all 5 pushes succeeded in one run. Loss under eviction is unproven either way. |
| `queue-cli` dependency on `app-module-queue` is dead | Weak (C): `bundle.ts` / `daemon-entry.ts` use its path. Optional cleanup. |

## Phase 0: partial implementations to state up front

| Item | Evidence |
|---|---|
| `queue relay start` cannot work in a published install | R: MODULE_NOT_FOUND above. C: `bundle.ts` has 4 entries, none for the relay; dist `files` has no `node_modules`; code comment calls it "a follow-up". |
| `queue relay start` fails on any fresh config | **New (R)**: `RelayDaemon` never creates `<configDir>/relay-daemon`; `createDaemon` dies on `ENOENT` opening `config.lock`; CLI prints only `[fail] ... within 5s`. `~/.config/queue` has no such dir. Blocks the feature even in dev. |
| Relay plugins cannot load in a published install | C: `plugin-api.ts:43` bare `import(moduleName)`; `plugin-github` is private/unpublished. |
| Relay wake path cannot work in a published install | C: `push.ts:22` resolves unpublished `queue-core`. |
| Only the last relay subscription is active | C: `poc-node/lib/webhook-relay.js:127` overwrites `conn.filter`. |

## Phase 1: stop silent failures (do first)

| # | Fix | Evidence |
|---|---|---|
| 1.0 | `mkdir -p <configDir>/relay-daemon` before `createDaemon`. Test with a fresh config dir. | R |
| 1.1 | Relay logs to `<configDir>/relay-daemon/relay.log` (append). Do before the rest: every message below is currently lost. | R: `[relay] relay.yml has no plugins configured.` only reaches stdout; C: `RelayDaemon.ts:30`, `stdio: 'ignore'` |
| 1.2 | Wrap `loadRelayConfig` in try/catch in `connectLoop`; `.catch` on `connection.start()` that logs and exits 1. | R: bad YAML -> daemon exits 1, actionable message only on stderr; C: `RelayConnection.ts:60`, `RelayDaemon.ts:46` |
| 1.3 | Log `status: 'aborted'` as failure with `reason`. | C: `RelayConnection.ts:186`; `QueueDaemon.ts:127` |
| 1.4 | `queue relay start`: validate `relay.yml` first (missing -> `[fail]` with the path; invalid -> the YAML error); when the daemon dies early, print the last log line instead of a generic timeout. | R: missing `relay.yml` -> `[ok] relay client started`, `connected:false`; invalid / fresh dir -> `[fail] ... within 5s`, no cause |
| 1.5 | `queue relay stop`: exit 1 on failure; distinguish "not running" from "failed". | R: `[fail] relay client not running or failed to stop`, `exit=0` |
| 1.6 | Auth failure: expose `lastError` / `lastCloseCode` in `status`. | C: relay closes 4001; client loops at up to 30s with no signal |
| 1.7 | `relayUrl`: refuse `ws:` unless localhost. | C: `config.ts:21` `z.string().url()` |

## Phase 2: correctness

| # | Fix | Evidence / note |
|---|---|---|
| 2.1 | Multiple subscriptions: relay keeps `filters: []`, delivers on any match. Client stopgap: refuse >1 subscription per source with an explicit error. | C; cross-repo (`poc-node`), needs owner (D1) |
| 2.2 | Client evaluates `payloadMatch`; first fully matching subscription sets `queueEvent`. | C: `RelayConnection.ts:178` (`eventType` only), `:158` only forwards `payloadMatch` |
| 2.3 | `RelayEnvelope.headers`: relay sends 6 fields without it; make optional or add to the relay. | C: `plugin-api.ts:16` vs `webhook-relay.js` dispatch |
| 2.4 | `mapEvent`: `null` for falsy `eventType`; decide on `ping`. | C: relay sets `eventType = header \|\| null` |
| 2.5 | Single in-flight `ensureDaemonRunning` promise. | R: 5 concurrent calls -> 5 spawns |
| 2.6 | Design: relay pushes use `cwd: configDir`, so only global `subscribers.yml` matches in practice (D4). | C: `push.ts:35`, `ConfigLoader.ts:234`; impact I |
| 2.7 | Deferred: `deliveryId` dedupe, ordering, heartbeat, takeover-drain loss. | No ack by design (spec decision #4) |

## Phase 3: packaging (after D2, D3)

1. Relay spawns the same daemon entry as `queue start`: `queue relay start` resolves it (bundle-first, like `spawnDaemon`) and passes the path via env; `push.ts` uses that instead of `require.resolve`. Keeps `queue-relay-client` independent of `queue-cli` layout, restores `appCoreModule` registration, makes `standalone-entry.ts` removable (it has no `.catch`, no app-core options: C).
2. Add `relay-daemon-entry` as a 5th esbuild entry (`queue-relay-daemon.cjs`); update `copy-binaries.sh` and the `files` list in `generate-platform-packages.sh`.
3. Plugin loading (D3): built-in, published package, or absolute path in `relay.yml`.
4. `spawnDaemon` calls `spawnDetachedProcess`; the helper deletes its `.vbs`. R: 8 `queue-spawn-*.vbs` accumulated from 3 `relay start` + 5 wakes; C: `spawnDaemon` (`QueueIndex.ts:313-349`) still has its own copy.
5. Verify on a CI-built install (`queue cli update`), not the dev workspace.

If D2 is "later": `relay start` must fail with "not available in published builds" instead of `Fatal error: Cannot find module`.

## Phase 4: app-module backend and history CLI

All backend rows R against the published `backend.cjs` (994-entry history copy).

| # | Fix | Observed |
|---|---|---|
| 4.1 | Replay: `DaemonUnreachableError` -> 503, `ReplayError` -> 404, else 500. Test with real error classes. | Unknown id -> **409** while `GET /history/:id` gives 404; daemon down -> **409** while `/dlq` gives 503 |
| 4.2 | Validate `limit` (positive int, upper bound), `offset` (>=0), `sinceMs`, `status` -> 400; share logic with the CLI parser. | `limit=abc` -> 200, 0 entries, `limit:null`; `limit=-5` -> 989 entries; `offset=-3` -> 0; `limit=0` -> 0; `limit=1000000` -> all 994; `sinceMs=abc` -> filter silently ignored; `status=bogus` -> 200 empty |
| 4.3 | `--limit` / `-n` / `--offset` with a missing value: error. | R: `queue history --limit` -> silently the default 20 |
| 4.4 | `--follow` with `--limit` / `--offset`: warn. | R: `--follow --limit 1` printed 1184 lines |
| 4.5 | Dashboard history capped at 20, no paging. DSL `DataTable` has `page`, a `PaginationNode` exists; binding to server `limit`/`offset` unverified (D5). | C |
| 4.6 | `replayEvent` and `/subscribers` use app-core's `process.cwd()` (D6). | C: `replay.ts:32`; impact I |
| 4.7 | try/catch around `/status`, `/history`; validate `POST /push` body. | R: undefined body -> 503 `Cannot read properties of undefined (reading 'event')` |
| 4.8 | Document the `--json` shape change. | R: now `{entries,total,limit,offset}`; `--follow --json` stays per-line |

## Phase 5: docs and tests

- `CLAUDE.md:5`: "library API" is false; say "app-core module (routes via `manifest.json` `backendEntryPath`), not an importable library".
- `threat-model.md`: private repo data and payload size for relay events.
- Tests missing: `RelayConnection` (fake ws server: multi-subscription, bad `relay.yml` mid-run, `payloadMatch`, `aborted`), `RelayDaemon` (fresh config dir), `push.ts` (concurrent wake), `plugin-github` null `eventType` / `ping`, backend invalid params and error classes, CLI flag parsing. The probes in `/tmp/qprobe/` are a starting point.

## Decisions needed

| # | Question |
|---|---|
| D1 | Who owns the `poc-node` relay change (2.1, 2.3), and is it in scope? |
| D2 | Ship the relay in the published CLI now, or fail loudly until later? |
| D3 | Plugin distribution: built-in, published, or absolute path? |
| D4 | Should relay events reach project-level subscribers? |
| D5 | Dashboard history: paging or "latest 20"? |
| D6 | Which cwd for a dashboard replay? |

## Still unverified

- Event loss while a daemon drains during takeover (one concurrent run lost nothing; not conclusive).
- App-core auth in front of the backend routes (`/subscribers?cwd=`, `/push` accept arbitrary paths).
- DSL binding of `page` to server `limit`/`offset`.
- Why the `queue` shim returns no output through a pipe (observation only; out of this review's scope).

---

## Final status (2026-10-14)

Pushed to main (`af58ee6..9360f22`, 10 commits), CI run 38628839149 green and published.

| Phase | Result |
|---|---|
| 0 partial implementations | Fixed: relay shipped in the CLI (`queue-relay-daemon.cjs`, plugin-github built in), `relay-daemon/` dir created, multi-subscription handled on the client (one coarse subscribe per plugin + client-side matching). Relay-side list of filters: owner of poc-node accepted it, not landed yet. |
| 1 silent failures | Done: relay log file, config errors in the loop, `aborted` logged, `relay start` validation + tail of the log, `relay stop` exit code, `lastError` in status, `wss:` guard. |
| 2 correctness | Done: client-side `payloadMatch` (dotted paths), null event type, single in-flight daemon start, `headers` optional. |
| 3 packaging | Done: 5th bundle entry, `QUEUE_DAEMON_SCRIPT`, built-in plugin registry, self-deleting `.vbs`, single launcher implementation. |
| 4 backend / history CLI | Done: strict validation, `page`, error mapping, replay with recorded cwd, follow semantics. |
| 5 docs / tests | Done: CLAUDE.md, threat-model. |

Bugs found only by running the real artifacts (not by unit tests): bundled CLI could not load `./spawnDaemon.js`; eager `require.resolve` of an unpublished package; `relay stop` left the relay process alive; Windows-only errno assertion (CI is ubuntu); a smoke test that could not fail meaningfully.

Open:
- poc-node (poc-owner): keep a LIST of filters per connection (accepted, not landed). Until then two plugins with the same `source` overwrite each other (logged as a warning).
- Dashboard paging needs `@wadeck-app/dsl-ui >= 2026.10.12-091-dd4b2887` in app-core's frontend (app-core-owner).
- `packages/queue-core/src/daemon/standalone-entry.ts` is no longer used (the relay passes `QUEUE_DAEMON_SCRIPT`): delete it.
- Scratch files left by sub-agents in the repo root (untracked): see the list in the final report.
