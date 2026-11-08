# Plan: `queue wait` as a named, temporary subscriber

Status: plan only, nothing implemented. Research by reading code (commit 4933141); nothing was run.

## Goal

1. `queue push` reports waiters: `[ok] queued (0 subscribers, 1 waiting: w-agent-wake.ab12cd34)` instead of a `[warn] no subscribers` while a wait consumes the event.
2. A list shows who waits: name, events, `--when` filters, contact, since. Covers CLI and dashboard.
3. Unchanged: a wait still reads the history, so `--since` finds events recorded before it started.
4. Every wait has a name (`--name <who>.<what>`). `--name` becomes valid (today exit 4, unknown option).

Not a pull-only registry: the daemon holds a contact for each waiter and wakes it.

## Facts that drive the design

- `eventWaitCommand` polls `HistoryReader` every 500 ms (`FOLLOW_POLL_INTERVAL_MS`); it never talks to the daemon and does not start it (`waitCli.ts`).
- `QueueService.push` records the trigger in history before `subscriberCount` is returned (`filtered.length`, QueueService.ts ~683); `QueueIndex.ts` ~1040 warns on `count === 0` only.
- The daemon is a `singleton-daemon-kit` command surface: `POST /<command>` with Bearer token. It stops after 60 s idle (`IdleShutdown`: WAL empty, no dispatch, no running command). A long-lived command would keep it alive and delay its stop (drain).
- The relay already tracks waiters as files `relay-daemon/waiters/<pid>` with a dead-pid check (`onDemand.ts`, `RelayOnDemand`). The dashboard module reads queue files directly and works with the daemon stopped (`subscribers.ts`).
- `isValidSubscriberName`: `[a-z0-9][a-z0-9._-]{0,63}` (`ConfigLoader.ts`); a dot is allowed.
- `list-subscribers --json` and `queue sub list --json` print a bare array: scripts parse it.
- Protocol: a client must ignore unknown response fields (`push-protocol.md`), so a response field is MINOR.

## Decisions

| # | Decision | Alternatives rejected, and why |
|---|---|---|
| 1 | Source of truth: one file per live waiter, `<configDir>/waiters/waiter-<name>.json`, written by the `queue wait` process itself. The daemon reads the directory on each push; no register RPC | RPC `wait-register` + in-memory registry: the wait would have to start the daemon (it does not today), the registry is lost at each daemon stop (idle stop is 60 s) and needs re-registration logic, the dashboard could not read it with the daemon down. Files give daemon-restart rediscovery for free and atomic uniqueness (`wx` create) |
| 2 | Prefix `waiter-` in the file name | `<name>.json`: names such as `con.x` are Windows device names even with an extension |
| 3 | Liveness = pid alive AND file mtime younger than TTL. Heartbeat: the waiter `utimes` its own file every 15 s; TTL 60 s | pid only (relay's rule): Windows reuses pids and a killed background task leaves the file. mtime only: a crash would show as live for 60 s. Rewriting the JSON as heartbeat: torn reads, rename EPERM on Windows |
| 4 | Delivery: hybrid. After the history write, the daemon sends a fire-and-forget wake to each matching waiter's contact. The waiter treats it as a hint, polls the history at once, and the match is decided from the history only. The 500 ms poll stays as safety net | Pure registry: what the user rejected. Pure push (daemon sends the event, waiter trusts it): breaks `--since` (history-only), duplicates match logic, a forged or lost wake changes the result. Long-poll RPC on the daemon: holds the daemon alive and blocks its drain. Honest value of the wake today: <= 500 ms latency and a live contact; the real gain comes later by slowing the fallback poll (follow-up, not in this plan) |
| 5 | Contact kind `http`: waiter listens on `127.0.0.1:<ephemeral port>`, `POST /wake` with `Authorization: Bearer <per-waiter secret>`, body `{eventId, event}`; 204 | Named pipe / unix socket: two code paths (Windows vs POSIX). pid signal: not on Windows. fs.watch on the record: unreliable. Loopback HTTP matches the daemon (127.0.0.1 only) |
| 6 | The daemon never deletes waiter files while serving a push. Sweeping dead or stale files: done by a registering `queue wait` (all stale files) and by the daemon at start | Daemon deletes on push: races with a new waiter taking over the same name between read and unlink |
| 7 | A registered waiter does NOT keep the daemon alive; push starts the daemon on demand and finds the waiters in the files | Keeping it alive: a 30 m wait would defeat the idle stop for nothing, the wait does not need the daemon to read history |
| 8 | Name: required, format `isValidSubscriberName` plus at least one dot with non-empty parts (`<who>.<what>`). Unique among LIVE waiters of one config dir: second live wait with the same name exits 4 naming the holder (pid, since). A dead or stale holder is taken over silently with an `[info]` line | Auto-suffix on collision: hides a double launch by an agent; refusing is the signal |
| 9 | Missing `--name`: two releases. Release A: default `anon.<pid>` and a visible `[warn] --name missing`. Release B (one constant, `WAIT_NAME_REQUIRED`): exit 4 with a suggested command. Flip B once poll-event and w-agent-wake pass the name | Refuse from day one: every existing agent instruction and test breaks at the CLI auto-update, before the skills are updated |
| 10 | Response fields on `push`: `waiterCount` and `waiters` (names, capped at 20), on `queued` and `dispatched`. Counting rule below. Protocol 1.7.0 (MINOR) | Changing `subscriberCount` to include waiters: breaks its meaning for SDK users, `queue push` and the dashboard widget |
| 11 | Listing: `queue waiters [--json]` (new command) is the machine route. TTY text of `queue list-subscribers` and `queue sub list` (without `--scope`) append a `Waiting now` section. Their `--json` arrays are unchanged | Adding a `waiters` key to the JSON: changes a bare array into an object, breaks scripts. `queue wait list`: a name clash with an event called `list` (`ci` is already reserved) |
| 12 | Dashboard: route `subscribers` gains a `waiters` key; the Subscribers page gains a second table (scope "temporary") | New page: the user asked for the existing Subscribers page |
| 13 | No retry, no WAL, no DLQ for a waiter | A missed wake is harmless: the history is the delivery, the poll the retry |
| 14 | The relay `waiters/<pid>` mechanism is left as is (follow-up: derive it from these records; share `processIsAlive`) | Merging now widens the change to the relay package |
| 15 | `queue wait ci` gets `--name` too, registered with the single target `on.github.workflow_run` | Naming only event waits: the user said every wait |

### Counting rule (daemon, per push)

A live waiter counts when any of its targets has a pattern matching the event name (`EventMatcher.matches`) and all its `whens` hold on the envelope (`PayloadFilter.evaluate`). An `--all` wait counts even if some of its targets are already satisfied (documented). Waits are not scoped by project or cwd (the history reader is not). Evaluation errors count as "matches" (never hide a waiter).

## Protocol and wire change

- `docs/push-protocol.md`: version 1.7.0; `queued` and `dispatched` carry optional `waiterCount` (number) and `waiters` (string[]); History row. `PROTOCOL_VERSION` in `queue-sdk/src/protocol.ts`; `PushResponse` in `QueueCommands.ts`, `queue-sdk/src/wire.ts` (parser copies fields one by one: add both, validated types).
- `contract/protocol-1.json`: add a case in the same commit (the format of expectations was not read: check how `subscriberCount` is asserted). Add `WAITERS_MIN_VERSION = '1.7.0'` helper like `daemonSupportsPushProject`.
- No request change, no new RPC, no change of the `accepts` range.
- Waiter file format is a local file contract, not a wire one; it carries `v: 1`; the reader ignores records with an unknown `v` and says so once.

## Waiter record (`waiter-<name>.json`, at most 16 KB)

| Field | Meaning |
|---|---|
| `v` | 1 |
| `name` | equals the file name part; checked on read |
| `pid` | pid of the `queue wait` process |
| `startedAt` | ISO; the "since" of the list |
| `kind` | `event` or `ci` |
| `mode` | `any` or `all` |
| `targets` | `[{event, whens[]}]`, max 20 targets, 20 whens each, 500 chars each |
| `historySince` | ISO of the effective `--since` (shown, not used by the daemon) |
| `timeoutAt` | ISO; shown as "expires" |
| `cwd` | cwd of the waiter (information) |
| `cliVersion` | for diagnosing skew |
| `contact` | `{kind:'http', port, secret}` |

`secret` never leaves the reader: `listWaiters()` returns a redacted view (no `secret`); only the daemon notifier uses the raw one. File created with mode 0600 (no effect on Windows; a same-user process can read `health_token` anyway).

## Lifecycle

1. Parse args (name validated) -> open the wake listener (ephemeral port) -> `registerWaiter` (`wx` create; on EEXIST: read holder, live -> exit 4; dead or stale -> unlink, retry up to 3 times) -> heartbeat timer -> existing flow (history read, poll loop).
2. Registration happens before the first history read, so a push racing the start is counted; an instantly satisfied wait still registers for a few ms and deregisters.
3. End (match, timeout, usage error after registration, SIGINT/SIGTERM, `exit`): stop timer, close listener, delete the file only if its `pid` is still ours.
4. Waiter crash: pid dead -> not live at once; pid reused -> heartbeat stale after 60 s. Files are swept by the next registration.
5. Daemon crash or idle stop: no effect on waiters; next push starts the daemon, which reads the directory. Nothing to re-register.
6. Waiter registered but its listener cannot bind: registration still succeeds without `contact` (kind `none`), `[warn]` once on stderr with the cause; the list shows `contact: none (polling only)`. Not silent, not fatal.
7. Daemon cannot reach a contact (refused, timeout 1 s): one `logDiagnostic` per waiter name and run (names the waiter, port, and that it still polls); the push result is unaffected.
8. Wake order in `push`: history trigger written -> count/collect waiters -> (async, not awaited) wake -> return. The wake is never awaited by the push.

## Push wording (`QueueIndex.ts` ~1040, `httpAnswers.ts` ~37)

| subscribers | waiting | stream | text |
|---|---|---|---|
| 0 | 0 | stderr | `[warn] queued - no subscribers and no one waiting for 'x'` |
| 0 | 1+ | stdout | `[ok] queued (0 subscribers, 1 waiting: a.b)` |
| N | 0 | stdout | `[ok] queued (N subscribers)` (unchanged) |
| N | M | stdout | `[ok] queued (N subscribers, M waiting: a.b, c.d)`; more than 3 names -> `... +k more` |
| field absent (old daemon) | - | - | exactly today's text |

Same logic in the dashboard push answer (`httpAnswers.ts`) and `queue-sdk/docs/troubleshooting.md` line 30.

## Failure messages (actionable)

- Name taken: `--name 'a.b' is already used by a live wait (pid 123, since 2026-11-08T10:00:00Z, waiting for onX). Fix: choose another name, or stop pid 123.`
- Bad name: `--name 'X' must look like <who>.<what> ([a-z0-9][a-z0-9._-]*, at most 64 chars), e.g. w-agent-wake.ab12cd34.`
- Missing name (release B): `queue wait needs --name <who>.<what> so 'queue push' and 'queue waiters' can say who waits. Example: queue wait onX --name w-agent-wake.ab12cd34`. Release A: `[warn] no --name: registered as anon.<pid>. A name will become mandatory.`
- Unreadable or malformed record in the daemon: one diagnostic with the path; the record is ignored, never counted.
- Waiters directory not writable: exit 1 with the path and cause; the wait is not started unnamed and unregistered (a wait nobody can see is the bug being fixed).

## Security

- Daemon RPC auth unchanged (Bearer `health_token`); no new endpoint on the daemon.
- The waiter's listener binds 127.0.0.1 only, requires the per-waiter secret, accepts only `POST /wake`, body max 1 KB, answers 204 or 401; wakes are coalesced (at most one extra poll per 100 ms), so a local flood cannot do more than the existing poll. A wake never decides a match.
- Port reuse after a crash could send the secret to another local process: bounded by the liveness rule and the 1 s timeout; the secret protects only the wake.
- Names are regex-validated: safe in file names, logs, dashboard. Events are validated with the existing pattern rules. `whens` and `cwd` are free text: control characters are stripped when printed in the terminal; the dashboard renders strings as DSL text (escaping not verified, see risks).
- The dashboard and CLI list never show `secret`. `whens` are shown unmasked (same as subscriber `when:`); documented.
- Daemon treats the directory as untrusted input: size cap, JSON shape check, name equals file name, max 200 files scanned (more -> diagnostic).

## Docs to update

`docs/wait.md` (new section "Naming and listing"; Options paragraph: `--name` valid), `WAIT_HELP` (`waitCli.ts`), `docs/push-protocol.md` (+ History), `docs/subscribers.md` ("temporary subscribers" pointer under `queue sub list`), `queue-sdk/docs/troubleshooting.md`, root `CLAUDE.md` (route `subscribers` now carries waiters; `queue waiters`), `docs/project-integration.md` if it lists the route shape, `QueueIndex.ts` usage text, `commandFlags.ts`/`exitCodes.ts` entries for `waiters`, `.claude/product-vision.md` known gaps, `.claude/threat-model.md` (new local file + loopback listener), CLAUDE.md of the user repo skills (below).

Outside the repo, to hand to the user/peer: `~/.claude/skills/poll-event/SKILL.md` (every `queue wait` line gets `--name <who>.<what>`, minimum CLI version = the release of step 6) and w-agent-wake (`--name w-agent-wake.<first 8 chars of session id>`; check those 8 chars match the name regex: uppercase or non-hex ids need lower-casing).

## Compatibility

| Case | Result |
|---|---|
| New CLI/daemon, old SDK client | ignores `waiterCount`/`waiters` |
| New SDK, old daemon | fields absent, behaviour as today |
| Old `queue push`, new daemon | prints the old `[warn]` (misleading as before, no regression) |
| New `queue push`, old running daemon (not yet restarted after update) | no field -> old text |
| Old `queue wait` | not registered, invisible, as today |
| Scripts parsing `list-subscribers --json` / `sub list --json` | unchanged |
| `queue wait x --name n` on an old CLI | exit 4 unknown option: skill states the minimum version |

## Test plan (TDD: write each test red first, then the code)

All tests use `createIsolatedCliEnv()` / temp config dirs, injected `now`, `isAlive`, `IdleTimers` (existing type) and `sleep`; no assertion on elapsed time; counters or `onTick` hooks instead of waiting.

1. queue-core `WaiterRegistry.test.ts`: `validWaiterName accepts who.what, refuses no dot / uppercase / 65 chars / path separators / device names`; `register creates waiter-<name>.json with wx`; `second live register throws NameTaken with holder pid and since`; `dead pid holder is taken over`; `stale heartbeat (injected now > TTL) is taken over even if pid alive`; `two simultaneous takeovers: exactly one wins`; `unregister deletes only own pid`; `heartbeat touches mtime via injected timers`; `listWaiters hides secret`; `malformed / oversize / unknown v / name!=file ignored and reported once`; `sweep removes only stale`.
2. queue-core `WaiterMatch.test.ts`: `pattern target matches`, `whens all hold`, `any target suffices`, `--all waiter still counts`, `evaluation error counts`, `no match -> not counted`, `dead waiter not counted`.
3. queue-core `QueueService.waiters.test.ts`: `push with 0 subscribers and 1 matching waiter -> waiterCount 1 and its name`; `non-matching waiter -> 0`; `N subscribers unchanged`; `before* event also carries waiterCount`; `history trigger is written before the wake is sent`; `unreachable contact never fails the push and logs one diagnostic`; `wake not awaited (contact that never answers does not delay the answer, proven with a deferred promise)`; `daemon never unlinks waiter files`; `directory with 201 files -> diagnostic`.
4. queue-core `WaiterNotifier.test.ts`: wake request shape (Bearer secret, body); timeout; no contact -> skipped.
5. queue-sdk `wire.test.ts` + `contract.test.ts`: both fields parsed, wrong types dropped; protocol constants test (`1.7.0`, helper); `protocol-1.json` case.
6. queue-cli `eventWaitArgs.test.ts`: `--name` accepted, value required, repeated refused, `--name=x` refused (existing rules), invalid format message, same for `wait ci` (`ciWaitArgs.test.ts`); release A default `anon.<pid>` + warning; release B refusal text (flag-driven test of `WAIT_NAME_REQUIRED`).
7. queue-cli `waitRegistration.test.ts`: `registers before the first history read`; `deregisters on match, timeout, usage error, SIGINT`; `name taken exits 4 with holder`; `listener bind failure -> contact none + warn, wait continues`; `wake resolves the interruptible sleep and polls once`; `a wake for an event not in history does not match` (hint only); `--since 10m still matches an earlier event while registered` (requirement 3); `queue wait ci` registers `on.github.workflow_run`.
8. queue-cli `pushMessage.test.ts` (table): every row of the wording table, stdout vs stderr, `+k more`, absent field.
9. queue-cli list tests: `queue waiters` text and `--json`; TTY `sub list` shows the section; `--json` of `sub list` and `list-subscribers` byte-identical to before (snapshot); `--scope` listing shows no waiters.
10. Integration (`createIsolatedCliEnv`, real bundle, `testBundleFile()`): start `queue wait x --name a.b` in background, `queue push x` prints `[ok] queued (0 subscribers, 1 waiting: a.b)`, the wait exits 0; kill -9 the wait, push prints the `[warn]` variant; daemon stop/restart while a wait is registered, push still counts it.
11. app-module-queue: `subscribers route returns waiters without secret`; `route works with daemon stopped`; page YAML binds exactly the new columns; CLAUDE.md route list test still green.
12. Mutation controls (the repo practice): flip TTL, pid check, `wx`, secret redaction, and the order history-then-wake; each must fail a test.

## Steps for the implementing agent

1. Protocol 1.7.0 doc + constants + `PushResponse` types + wire parser + contract case (tests 5 first).
2. queue-core `WaiterRegistry` (record, name rules, register/takeover/heartbeat/list/sweep) and `WaiterMatch` (tests 1, 2). Export from `index.ts`; the module imports it from queue-core only.
3. Daemon: collect waiters in `push`, return fields, sweep at `onStart` (test 3). No wake yet.
4. `queue-cli`: `--name` parsing for event and ci, registration wiring in `waitCli.ts`, release A default and warning (tests 6, 7 without the wake parts).
5. Push wording in `QueueIndex.ts`, `httpAnswers.ts`, SDK troubleshooting (test 8). At this point requirements 1 and 3 hold; requirement 2 and the contact are still missing: say so in the commit message.
6. Listing: `queue waiters`, text sections in `list-subscribers` and `sub list`, dashboard route and page (tests 9, 11). Release this: minimum CLI version for the skills.
7. Wake: `WaiterNotifier` (daemon) and the loopback listener plus interruptible sleep (CLI) (tests 4, 7 wake parts, 10).
8. Docs and `.claude` files listed above; bundle + integration run.
9. After the skills and w-agent-wake pass the name: set `WAIT_NAME_REQUIRED` to true, update release-B tests and the docs. Separate commit.
10. Run mutation controls (test 12).

Step 5 is a deliberate partial state (no contact, no list): do not tag it as the feature.

## Risks and not verified

- Not read: `ciWaitArgs.ts`, `QueueClient.ts`, the structure of `contract/protocol-1.json`, `AtomicRename`/`FileLock` use, the daemon kit's request timeout and drain code, app-core DSL escaping of strings, the push-test and replay paths for other "no subscribers" texts (grep `no subscribers` before step 5).
- Not verified: whether `queue cli update` restarts a running daemon (affects how long old wording survives); the cost of scanning N waiter files per push (budget to measure with 50 files before any cache; a cache would hide waiters that registered a second ago); Windows behaviour of `utimes` on a file another process reads; antivirus delaying the file create.
- `HistoryReader` caches by mtime: two history writes within one mtime tick could hide the second from a cached reader. Pre-existing, but a wake makes the window easier to hit; reproduce before shipping the wake.
- Pid reuse plus port reuse (see Security) is mitigated, not eliminated.
- `--all` waits are counted while partly satisfied: the number can overstate who still needs the event.
- A wait is not scoped by project: a name shows for every project's pushes that match its pattern.
- Phase A default `anon.<pid>` names are noise in the lists until release B.
- Wake gain today is <= 500 ms; if the user judges that not worth a listener per wait, decisions 4 and 5 can be dropped without touching the rest (the contact field then stays `none`).
