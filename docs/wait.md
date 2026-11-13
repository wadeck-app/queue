# Waiting instead of polling

`queue wait` blocks until something happens; an agent launches it with `run_in_background` and is re-invoked when it exits. `queue wait --help` has the full option list.

## Options

An option `queue wait` does not know exits 4 with the closest valid one (`unknown option '--timout' for 'queue wait' (did you mean '--timeout'?)`), for the event wait and for `wait ci`. Also exit 4: a value flag without its value, given twice, or written `--flag=value`.

## `queue wait <event>`

Blocks until a queue event of that name is recorded (any `queue push`, even with no subscriber).

- `--when <expr>` (repeatable) keeps events whose payload satisfies the expression, same syntax as a subscriber's `when:`.
- `--since <duration|time>` also counts events recorded earlier, so there is no race with the thing you waited for. Default: events recorded after the command started.
- `--timeout <duration>` gives up after that long (default 30m; `30s`, `15m`, `2h`).
- `--name <who>.<what>` names the wait, see [Naming and listing](#naming-and-listing).
- A name like `on.github.workflow_run` is a relayed event and needs the relay (see below).

### Patterns

A name containing a segment that is exactly `*` or `>` is a pattern, matched like `subscribers.yml` (same rules: the loader refuses the keys `queue wait` refuses). It also matches names that appear later.

| Token | Matches |
|---|---|
| `*` | exactly one segment |
| `>` | one or more remaining segments; last position only |

| Pattern | Matches | Does not match |
|---|---|---|
| `dep.*` | `dep.a` | `dep`, `dep.a.b` |
| `dep.>` | `dep.a`, `dep.a.b` | `dep` |
| `*.published` | `dep.published` | `published`, `a.b.published` |
| `>` | every event | |

- Names with dots (`dep.a.b`, `on.github.workflow_run`): use `>` to cover every depth; `*` stops at one.
- ALWAYS double-quote: `queue wait "dep.>"`. Unquoted, `>` is a shell redirect (stdout goes to a file named after the next word, and the command receives `dep.`, which exits 4 with a hint) and `*` is globbed.
- `**` is not a wildcard (`>` is the only multi-segment one, here as in `subscribers.yml` and `queue events list --match`) and exits 4: `"dep.**": "**" is not a wildcard, use ">" (the rest of the segments) instead: "dep.>"`.
- A wildcard inside a segment (`dep.pub*`), an empty segment, a trailing dot or a non-last `>` exits 4.
- `--all`: each pattern is satisfied by any one matching name.
- `--strict` never refuses a pattern (its names may come later).
- No declared or recently pushed name matches: `[warn]` on stderr (`[info]` when the catalog and history are empty). Find names with `queue events list --match "dep.>"`.
- A pattern starting with `on.` (`on.github.*`) starts the relay; a bare `>` does not (`[info]` on stderr).
- `--json`: the result's `event` is the concrete name that matched. A pattern has no `declared` / `suggestions`. A timeout adds `lastSeenEvent` (latest matching name) and, with several targets, `"pattern": true`.

### Several events at once

Write the events one after the other; a `--when` belongs to the event written before it, so each has its own filters (the same event may appear twice with different filters).

```
queue wait onTaskDone --when "payload.taskId=abc" onTaskFailed --when "payload.taskId=abc" --timeout 1h
```

- Default (`--any`): the first event that happens ends the wait and says which one (`wait 2 of 2 matched: ...` on stderr, `"target": 1` in `--json`, the position of the wait). When several already happened, the oldest wins.
- `--all`: ends when every event has happened; `--json` gives `{"matched":true,"mode":"all","entries":[{"target":0,"entry":{...}},...]}`.
- A timeout lists the waits that stayed open (in `--json`, `targets` with `matched` and, for the open ones, `lastSeenAt`).
- `--strict` refuses the whole wait if one of the names is undeclared.

## `queue wait ci [<sha>]`

Blocks until the GitHub CI of a commit is done. SHA defaults to `HEAD`, repository to the `origin` remote. A CI that finished before the command started is answered at once.

Inside a git repository it also reads git:
- Refuses a commit that is not on the branch's upstream ("not pushed, run `git push`"), since no CI would ever run.
- Infers the expected workflows from the commit's `.github/workflows/*.yml` (`name:`, `push` trigger, branch filters, path filters checked against the tip commit). If no workflow runs on push for this branch it says so at once (exit 3).
- Falls back to the generic rule below when it cannot decide (negated patterns, detached HEAD, unparsable file) and says why on stderr. `--no-infer` disables all of this.

Without an inferred list, "done" means every workflow run seen for the commit is completed and nothing new happened for `--settle` (default 20s). With `--workflow <name>` (repeatable), only those workflows count and git is not used to guess.

Only the relayed history of the last 24 h is read. A commit pushed earlier looks like "no run seen" (exit 3); pass `--since <duration|time>` (same syntax as the event wait: `3d`, `2026-10-18T11:00:00Z`) reaching back past its push. The exit 3 message names the window read.

## The relay

`queue wait ci` and a wait for an `on.<source>.<type>` event need the relay client. If it is down and the history holds nothing yet, the wait starts it (`relay.yml` must exist, see `queue relay --help`), and the relay stops itself 30 s after the last such wait ended. A relay started with `queue relay start` is never stopped automatically.

The relay does not replay events missed while it was down: a wait only sees events that arrive while it is connected.

### Repositories the relay does not cover

A GitHub webhook only covers the repositories of its owner, and the relay is configured for the organisation only. The repositories of the personal account are deliberately not relayed: `queue wait ci` on one of them ends with exit 3 ("No workflow_run delivery from <owner>/<repo> reached the relay"), whatever the CI does. That is expected, not a fault of the relay or of the webhook. For those repositories do not use `queue wait ci`: poll the run with the GitHub tools (`gh run list --commit <sha>`, or the GitHub MCP tools, see the `poll-event` skill).

## Naming and listing

Every wait (event or CI) is listed while it runs, so `queue push` can say that someone consumes the event and a human can see who waits. The wait writes `<config dir>/waiters/waiter-<name>.json` before its first history read; the daemon reads the folder on each push. `--history` and the lists need no daemon.

`--name <who>.<what>`, for `wait <event>` and `wait ci` alike:

| Rule | Example |
|---|---|
| Lower case, `[a-z0-9][a-z0-9._-]*`, at most 64 characters | |
| At least one dot, no empty part | `w-agent-wake.ab12cd34`, `deploy.ci-9d9c4f7` |
| Unique among live waits of one config dir | a second live wait with the same name exits 4 and names the holder (pid, since) |

Put the awaited thing in the name: one session often runs several waits (`wait ci` and a task wait), and each needs its own. A bad name exits 4 with the rule and an example.

**Without `--name` (transitional).** The wait is called `anon.<pid>` and prints one `[warn]` on stderr; lists mark it `(no --name)` (`"anonymous": true` in JSON). A name will become mandatory in a later release (exit 4 with an example), once the agent skills pass `--name`: add it now.

**What the record holds.** Name, events, `--when` filters, label (the commit for `wait ci`), the effective `--since`, the working directory, the pid, the start time. A wait with several events registers one filter list: the common one when all events share it, none otherwise (it is then counted for more pushes than needed, never fewer). `wait ci` registers `on.github.workflow_run` for every repository; the commit is the label, and the count is by event name only. The wake contact is `pipe` (the daemon wakes the wait, see "The wake") or `none` ("polling only": the wait polls the history every 500 ms, 1 s for CI). No payload is ever stored; `--when` and the cwd are shown as written.

**Lifecycle.**
- Registration happens before the history is read, so a push racing the start counts it, and `--since` still finds earlier events.
- A heartbeat every 15 s touches the file. A wait is live while its process exists and its heartbeat is under 60 s old; a list marks a heartbeat over 30 s late `(stale)`. A wait that finds its record gone or replaced (a sleeping machine) registers again and warns once; it never crashes for a file error.
- It leaves the list and writes its `end` record on every exit it controls: matched, timeout, SIGINT/SIGTERM/SIGHUP (outcome `cancelled`, exit 130/143/129), process exit. A wait that is killed hard (SIGKILL, power) writes nothing: the next listing, registration or sweep records it `lost` at its last heartbeat. A file is never deleted by a wait that does not own it.
- A folder that cannot be written exits 1 with its path: a wait nobody can see is not started.

**`queue push`.** `[ok] queued (0 subscribers, 1 waiting: a.b)` while a wait consumes the event; the `[warn]` for "no subscribers and no one waiting" only when nobody does either. A wait counts when one of its events matches the name and its filters hold; waits are not scoped by project, and an `--all` wait counts until it ends.

**Lists.**
- `queue waiters [--json]`: name, events and filters, label, contact, since, last seen, pid. `--json` is an array (`id`, `name`, `anonymous`, `events`, `whens`, `label`, `contact`, `pid`, `cwd`, `since`, `startedAt`, `lastSeen`, `stale`).
- `queue list-subscribers [event]` and `queue sub list [event]` (without `--scope`) append a "Waiting now" section on a terminal, only when someone waits. Their `--json` arrays and piped output are unchanged.
- `queue waiters --history [--since <duration>] [--name <glob>] [--outcome <o>] [--limit N] [--json]`: newest first, with from, to, duration, outcome (`matched` with the event and its id, `timeout`, `cancelled`, `refused` for a taken name, `lost`, or `waiting`). Journal: `waiters/history/<day>.ndjson`, 90 days. For a CI wait, exit 0 and 1 (passed, failed) are recorded `matched`; exit 2 and 3 (timeout, no run, relay down) `timeout`.
- Dashboard: the **Queue Waiters** page (menu figure = waits running now) shows both lists, refreshed every 15 s, with the History filters on name (`*` glob) and outcome; the event of a `matched` wait links to the History page. Routes `GET /waiters` and `GET /waiters/history` read the same files with the daemon stopped.
- `queue waiters` (and a registering wait, and the daemon start) sweeps first: the waits that are over are recorded `lost` once and named on stderr (`[info]`). The dashboard routes never sweep: a wait that is over is not listed and shows `lost` in the history. A record that cannot be read is named with its path (`[warn]`) and ignored.

## The wake

`queue push` wakes the waits that listen, so they see the event at once instead of at the next poll. It is a hint: the wait re-reads the history immediately and only the history decides, and the poll stays as the safety net, so a lost, late or forged wake changes nothing. `--since` is unchanged.

| | Windows | POSIX |
|---|---|---|
| Address | `\\.\pipe\queue-wait-<hash of the config dir>-<name>` | `<config dir>/waiters/wake-<hash of the name>.sock` (mode 0600) |
| Too long for `sun_path` (103 bytes, the macOS limit minus the NUL, used everywhere) | n/a | `<tmpdir>/queue-wait-<uid>/<hash>-<hash>.sock` in a 0700 folder; if still too long, no wake |
| Left behind by a killed wait | nothing (the pipe vanishes) | swept by the next wait that registers (a connection to it is refused) |

- The address is derived from the config dir and the validated name only. The record's `contact.path` is informational: the daemon recomputes the address and refuses, with one log line, a record whose path differs.
- The wake line is `{"wake":1,"event":...,"eventId":...}`: no payload. The wait ignores any other line, and serves at most 8 connections at once.
- The daemon connects with a 1 s timeout after the history write, never awaits it, and logs each failure cause once per run; the push answer is unaffected.
- No wake (reason on stderr as one `[warn]`, contact `none`): the address is held by a live process (a same-name wait), the folder is not safe (not owned by the user, or group/other writable and not fixable), the path is too long, the system refuses. The wait still works by polling.
- The wait closes the pipe and removes its socket on every exit it controls.

## Exit codes

| Command | 0 | 1 | 2 | 3 | 4 |
|---------|---|---|---|---|---|
| `wait <event>` | matched | - | timeout (`--timeout`, default 30m) | - | invalid usage, invalid or taken `--name` |
| `wait ci` | all runs `success`, `skipped` or `neutral` | a run failed, was cancelled or timed out | `--timeout` (default 30m) | no run seen for the commit, or relay not running | invalid usage, invalid or taken `--name` |
| `waiters` | listed (also when empty) | invalid flags, unreadable folder | - | - | - |

Exit 2 and 3 print the likely causes and `gh run list --commit <sha>` as a cross-check; GitHub does not redeliver lost webhooks.
