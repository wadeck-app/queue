# Guiding Principles — queue

## `before*` events are synchronous and can abort; `on*` events are async fire-and-forget

This is a core protocol contract. `before*` events call `SyncDispatcher`, block until all subscribers respond within the timeout, and can return `{ action: 'aborted' }`. `on*` events are written to the WAL immediately and dispatched by `AsyncDispatcher` without blocking the caller. Never invert this.

## WAL is the source of truth for in-flight events

An event is not considered dispatched until the WAL entry is updated to `status: 'acked'` or moved to the DLQ. Do not remove WAL entries prematurely. The WAL is replayed on daemon startup to reschedule any `pending` entries.

## WAL and DLQ are mutable state files guarded by a lock, not append-only logs

`wal.ndjson` and `dlq.ndjson` are rewritten whole (temp file + rename) on every write, so two processes writing at once lose entries (measured: ~200 of 400 lost, one writer crashed). Every write goes through `FileLock` (`<file>.lock` holding the writer's pid, retry with backoff, taken over when the pid is dead or the lock is 5 s old), one temp file per pid, and `assertHeld()` right before the rename. Readers never lock. `history/` and the event log are real append-only files (`appendFileSync`) and need none of this.

## Config is merged: global first, then project-local

`~/.config/queue/subscribers.yml` is loaded first; `.queue/subscribers.yml` in the project tree is merged on top. Subscribers from both apply. Never document or implement a "project overrides global" semantics — they accumulate.

## Errors must be loud, not silent

YAML parse errors in `subscribers.yml` throw with the file path and a fix hint. Zod validation failures throw with the full error and a schema hint. Do not silently skip invalid subscribers or return empty results.

## Deploy via CI, never via local `node_modules` editing

The deployment contract is: `git commit` + `git push` → CI publishes → `queue cli update`. Never validate behavior by editing `node_modules` or running `node dist-bundle/queue.cjs` directly. Test with the globally installed `queue` binary after `npm install -g`.

## `QUEUE_CONFIG_DIR` env var is the only supported config location override

Do not add other config location mechanisms. Document this env var in `--help` output.

## Retry defaults: 5 retries, exponential backoff, 30s timeout

These are the defaults in `ConfigLoader.toResolved()`. Any change to defaults is a breaking change for existing subscribers that don't override them explicitly.

## Idle shutdown: 60s after queue is empty and no active dispatches

`IDLE_TIMEOUT_MS = 60_000` in `queue-cli/src/daemon/QueueDaemon.ts` (the logic it drives lives in queue-core's `createQueueService`). The daemon self-terminates when `wal.pendingCount() === 0 && activeDispatches === 0`. On shutdown, pending WAL entries are rescheduled synchronously via `RetryScheduler.scheduleRetry(entry, true)`.

## The relay client starts on demand and stops itself

Nothing starts the relay at logon. `queue relay start` runs it until `queue relay stop`. `queue wait ci`, and a wait for an `on.<source>.<type>` event, start it when it is down AND the history holds nothing yet (a CI already finished never starts it).

- Each such wait writes `<configDir>/relay-daemon/waiters/<pid>` and removes it on exit; a relay it started also gets `relay-daemon/on-demand`.
- The relay daemon's watchdog (`onDemand.ts`) stops it after 30 s without a live waiter. A killed wait leaves its file: it is told apart by its dead pid. The grace period keeps the relay up between two waits that follow each other.
- A relay started by hand has no marker and is never stopped by this logic. `queue relay start` on an on-demand relay removes the marker (pins it); `queue relay stop` removes it too.
- The remote relay does not replay missed events to a client that connects (by design; observed: no event pushed on connect). A wait only sees events that arrive while the relay is connected; the remote keeps its own history (`queue relay webhook history`, a dedicated endpoint).

## Package barrels are the public API, and are kept

`queue-core`, `queue-relay-client` and `plugin-github` each expose one `src/index.ts` (package.json `main`/`types`). It is the list of what may cross a package boundary; removing it would open `dist/...` internals to every consumer. The `ts/no-barrel-index` rule is suppressed on those three files with a stated reason. Add an export there only for a symbol another package really consumes.

## A dashboard view is not done until it was seen rendered

Passing route and YAML tests does not show a wrapped label or a clipped tile. Package the module (`BUNDLE_VERSION=x npm run bundle` in `packages/app-module-queue`), serve it with `APP_CORE_PORT=<free port> app-core-cli dev dist-module` (never 4850, that is the real app-core), and look at it with agent-browser in light, dark and a ~380 px viewport. Dashboard columns are about 270 px wide: stack tiles vertically. Repackaging does not reload a running dev server: `POST /api/modules/register` with `{"id":"queue","source":{"type":"file","path":"<abs>/dist-module/manifest.json"}}` does (forward slashes in the path). Stopping the background task leaves the `app-core-cli dev` node process alive: find it with `netstat -ano` on the port, check its command line, and stop it by PID (it needs the w-guardrails `kill` bypass). A DSL page whose `Form` select has `options` from a source needs `$if` on that option list, or the page crashes while the source loads.

## From lessons learned

- Never validate behavior with `node dist-bundle/queue.cjs` directly — the correct workflow is `git commit && git push` → CI passes → `npm install -g @wadeck-app/queue-cli` → test with `queue <cmd>`; the Go launcher, file resolution paths, and published package content all diverge from the local bundle.
- Never edit `node_modules` manually to simulate a deployment — changes made there are not representative of what CI publishes.
- `generate-platform-packages.sh` controls the `files` field of each platform package — a binary present in `dist-bundle/` but absent from that script will not be distributed even after `copy-binaries.sh` runs.
