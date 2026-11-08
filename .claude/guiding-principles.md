# Guiding Principles — queue

## `before*` events are synchronous and can abort; `on*` events are async fire-and-forget

This is a core protocol contract. `before*` events call `SyncDispatcher`, block until all subscribers respond within the timeout, and can return `{ action: 'aborted' }`. `on*` events are written to the WAL immediately and dispatched by `AsyncDispatcher` without blocking the caller. Never invert this.

## WAL is the source of truth for in-flight events

An event is not considered dispatched until the WAL entry is updated to `status: 'acked'` or moved to the DLQ. Do not remove WAL entries prematurely. The WAL is replayed on daemon startup to reschedule any `pending` entries.

## WAL and DLQ are mutable state files guarded by a lock, not append-only logs

`wal.ndjson` and `dlq.ndjson` are rewritten whole (temp file + rename) on every write, so two processes writing at once lose entries (measured: ~200 of 400 lost, one writer crashed). Every write goes through `FileLock` (`<file>.lock` holding the writer's pid, retry with backoff, taken over when the pid is dead or the lock is 5 s old), one temp file per pid, and `assertHeld()` right before the rename. Readers never lock. `history/` and the event log are real append-only files (`appendLine`) and need none of this. The temp file is flushed (fsync) before the rename (a power loss cannot leave a truncated WAL; measured cost: under 1 ms on a 225 KB file), a line that is valid JSON but not an entry (`null`, a number, an object without `id`/`status`/`meta`...) is quarantined to `<file>.corrupt` like an unreadable one, and a push writes all its WAL entries in one rewrite (`Wal.appendMany`: recorded whole or not at all). Only the newest 500 acknowledged entries are kept (and for 24 h): a rewrite of 40,000 acked entries took ~250 ms per write.

## Config is merged: global first, then project-local

`<config dir>/subscribers.yml` (default `~/.config/queue`) is loaded first; the `subscribers.yml` in the config folder of the registered project (and of its parents, root first) is appended after it (`ConfigLoader.load`). A `.queue/subscribers.yml` above the cwd is no longer read: it is an error naming the file and its destination. Subscribers from all files apply. Never document or implement a "project overrides global" semantics — they accumulate; only `cwd`/`env` resolve per file, subscriber over event over file.

## Errors must be loud, not silent

YAML parse errors in `subscribers.yml` throw with the file path and a fix hint. Zod validation failures throw with the full error and a schema hint. Do not silently skip invalid subscribers or return empty results.

## Queue stays domain-agnostic: it reports facts, it does not judge what a command should do

Queue records what happened (status, exit code, output tails) and never interprets it. Anything that depends on what a subscriber, a producer or a tool means (is empty output suspicious? is this event normal?) belongs to the program that knows, not to a queue-wide rule. Rejected on this ground: a warning for "exit 0 with empty stdout" (see `out-of-scope.md`).

## Deploy via CI, never via local `node_modules` editing

The deployment contract is: `git commit` + `git push` → CI publishes → `queue cli update`. Never validate behavior by editing `node_modules` or running `node dist-bundle/queue.cjs` directly. Test with the globally installed `queue` binary after `npm install -g`.

## The config directory resolves in one order, shared by the launcher and Node

`--config <dir>` (launcher only, wins), then `QUEUE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/queue`, then `~/.config/queue` (`getQueueConfigDir`, `launcher-main.go.tmpl`). Do not add another mechanism. `QUEUE_CONFIG_DIR` is the one documented in `--help`; tests set it (and `XDG_CONFIG_HOME`/`HOME`) through `createIsolatedCliEnv()`.

## Retry defaults: 5 retries, exponential backoff, 30s timeout

These are the defaults in `ConfigLoader.toResolved()`. Any change to defaults is a breaking change for existing subscribers that don't override them explicitly.

## Idle shutdown: 60s after queue is empty and no active dispatches

`IDLE_TIMEOUT_MS = 60_000` in `queue-cli/src/daemon/QueueDaemon.ts`; the countdown is `IdleShutdown` (injected timers in its tests). The daemon self-terminates when `service.isIdle()` (no pending WAL entry, no active dispatch, no acknowledgement waiting to be written) holds when the countdown fires, not only when it started; every RPC command counts as activity and a running command keeps the daemon alive. On shutdown, pending WAL entries are rescheduled synchronously via `RetryScheduler.scheduleRetry(entry, true)`.

## Retries are orch jobs; a retry that cannot be scheduled is visible

A failed delivery with tries left creates a one-shot orch job (`orch add --once <id> --delay <d> --command "queue retry --event <walId>"`; orch requires the id and `--command`, the earlier call without them exited 4 and was never seen). When orch is missing or refuses, the entry becomes `failed` with the reason and the command to run by hand in its `lastError`, and the cause is logged once. `queue retry` of an entry that is being delivered is refused (one delivery at a time per entry). An entry is "stuck" (`give-up-stuck`) 2 h after the later of its creation and its `retryDueAt`.

## The relay client starts on demand and stops itself

Nothing starts the relay at logon. `queue relay start` runs it until `queue relay stop`. `queue wait ci`, and a wait for an `on.<source>.<type>` event, start it when it is down AND the history holds nothing yet (a CI already finished never starts it).

- Each such wait writes `<configDir>/relay-daemon/waiters/<pid>` and removes it on exit; a relay it started also gets `relay-daemon/on-demand`.
- The relay daemon's watchdog (`onDemand.ts`) stops it after 30 s without a live waiter. A killed wait leaves its file: it is told apart by its dead pid. The grace period keeps the relay up between two waits that follow each other.
- A relay started by hand has no marker and is never stopped by this logic. `queue relay start` on an on-demand relay removes the marker (pins it); `queue relay stop` removes it too.
- The remote relay does not replay missed events to a client that connects (by design; observed: no event pushed on connect). A wait only sees events that arrive while the relay is connected; the remote keeps its own history (`queue relay webhook history`, a dedicated endpoint).

## A wait is listed before it reads, and only its owner removes its record

`queue wait` registers (`waiters/waiter-<name>.json`, a random `id`, under `FileLock`) before the first history read, heartbeats every 15 s (live = process alive AND heartbeat under 60 s) and ends with an `end` record on every exit the process controls (`WaiterRegistry`, `waitSession.ts`). A file is deleted only when its `id` is ours; a wait that cannot write the folder is not started unlisted; a heartbeat or deregister error is said once, never fatal. A killed wait is `lost`, written once by the next sweep. `--name` is optional in this release (`anon.<pid>` + one warning); making it mandatory is a separate release. The count for `queue push` is by event name and filters only (not by project or commit). The wake (a named pipe or unix socket per wait, `WaiterWake.ts`) is a hint: its address is derived from the config dir and the validated name, the daemon never connects to an address read from a record, the wait re-reads the history on a wake and only the history decides a match, the poll stays. The dashboard GETs for waiters are read only (the CLI and the daemon start do the sweep). `STALE_AFTER_MS` and the `anon.` prefix are defined once, in queue-core (`WAITER_STALE_AFTER_MS`, `ANONYMOUS_WAITER_PREFIX`).

## Package barrels are the public API, and are kept

`queue-core`, `queue-relay-client` and `plugin-github` each expose one `src/index.ts` (package.json `main`/`types`). It is the list of what may cross a package boundary; removing it would open `dist/...` internals to every consumer. The `ts/no-barrel-index` rule is suppressed on those three files with a stated reason. Add an export there only for a symbol another package really consumes.

## A dashboard view is not done until it was seen rendered

Passing route and YAML tests does not show a wrapped label or a clipped tile. Package the module (`BUNDLE_VERSION=x npm run bundle` in `packages/app-module-queue`), serve it with `APP_CORE_PORT=<free port> app-core-cli dev dist-module` (never 4850, that is the real app-core), and look at it with agent-browser in light, dark and a ~380 px viewport. Dashboard columns are about 270 px wide: stack tiles vertically. Repackaging does not reload a running dev server: `POST /api/modules/register` with `{"id":"queue","source":{"type":"file","path":"<abs>/dist-module/manifest.json"}}` does (forward slashes in the path). Never kill an `app-core-cli` process: app-core-owner is responsible for them. Reuse one dev server across checks (it hot-reloads on `POST /api/modules/register`, no restart needed) rather than starting one per check, and leave it running. To compare two presentations, the `AbTest` node needs the shell to mount `<AbExperiments>` (the app-core-cli dev shell does not, so it only renders `initial`); without it, wire each variant as its own provisional dashboard widget in the manifest, look at them side by side on real data in light, dark and a narrow width, keep the winner and delete the others. Ship `AbTest` only while a test is under way, and replace it by the winning view when it ends (`abWidgets.test.ts` lists the widgets under test): shells without it show an unknown component. The app-core Vite frontend (`:5173`) mounts the dock; `?ab.<id>=<variant>` picks a variant for one page load. Chart lessons: a category axis shows one label when the names are long, and one outlier flattens every other bar, so a table beats a bar chart for "top N" of unevenly sized counts. A DSL page whose `Form` select has `options` from a source needs `$if` on that option list, or the page crashes while the source loads.

## No test may fail because the machine is slow

A test that fails on a loaded or slow machine is a bug in the test. Timeouts (`testTimeout`, `hookTimeout`, spawn and watchdog timers) are hang guards of several minutes, set once in the package's `vitest.config.ts`, never a performance limit and never overridden per test. Wait for the condition you need (a file, a port, a log line, an exit, a deferred promise) instead of sleeping and hoping; a sleep is allowed only when the delay is an input of the scenario. Never assert elapsed time or "A is faster than B". Build expensive fixtures (git repositories, bundles) once and copy them. Remove temporary directories with `maxRetries` (Windows keeps files open for a moment).

## Tests never use fixed ports, fixed temp names or the real config

The daemons ask for `QUEUE_DAEMON_PORT` / `QUEUE_RELAY_PORT` (defaults 47910/47911); `createIsolatedCliEnv()` allocates free ports per environment (`iso.daemonPort`, `iso.relayPort`), in-process daemons in tests pass `port: 0`. A test never skips or waits because another daemon holds a port (the user's real daemon, another session's run). The bundle is built once per run into `QUEUE_TEST_BUNDLE_DIR` by `packages/queue-cli/vitest.globalSetup.ts` (use `testBundleFile()`, never `dist-bundle/`), so queue-cli test files run in parallel. Temp files and dirs come from `mkdtemp` / `randomUUID`, never a fixed or timestamp-only name.

## No test reaches the real `orch`

A retry is an `orch add` job: a test that lets it run schedules a REAL job in the developer's orchestrator. Two layers: spawned bundles and daemons find a fake `orch` first on the PATH of `createIsolatedCliEnv()` (`env.orch.readCalls()` gives the recorded arguments; on Windows it is `orch.exe`, a link to node.exe preloaded through NODE_OPTIONS, because `where` + execFile run no `.cmd` shim); in-process daemons go through `armOrchGuard()` (`queue-core/src/orchGuard.ts`), armed by the `vitest.setup.ts` of queue-core, queue-cli, plugin-agent-wake and app-module-queue, which FAILS a test that reaches the scheduler without injecting its own deps or spying on `scheduleRetry`. A new package that can start a daemon in the test process gets the same setup file.

## From lessons learned

- Never validate behavior with `node dist-bundle/queue.cjs` directly — the correct workflow is `git commit && git push` → CI passes → `npm install -g @wadeck-app/queue-cli` → test with `queue <cmd>`; the Go launcher, file resolution paths, and published package content all diverge from the local bundle.
- Never edit `node_modules` manually to simulate a deployment — changes made there are not representative of what CI publishes.
- `generate-platform-packages.sh` controls the `files` field of each platform package — a binary present in `dist-bundle/` but absent from that script will not be distributed even after `copy-binaries.sh` runs.
