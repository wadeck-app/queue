# Waiting instead of polling

`queue wait` blocks until something happens; an agent launches it with `run_in_background` and is re-invoked when it exits. `queue wait --help` has the full option list.

## `queue wait <event>`

Blocks until a queue event of that name is recorded (any `queue push`, even with no subscriber).

- `--when <expr>` (repeatable) keeps events whose payload satisfies the expression, same syntax as a subscriber's `when:`.
- `--since <duration|time>` also counts events recorded earlier, so there is no race with the thing you waited for. Default: events recorded after the command started.
- `--timeout <duration>` gives up after that long (default 30m; `30s`, `15m`, `2h`).
- A name like `on.github.workflow_run` is a relayed event and needs the relay (see below).

### Patterns

A name containing a segment that is exactly `*` or `>` is a pattern, matched like `subscribers.yml`. It also matches names that appear later.

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
- `**` (an alias of `>` in `subscribers.yml`) exits 4: `"dep.**": "**" is not accepted by "queue wait"; use ">" instead: "dep.>"`.
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

## The relay

`queue wait ci` and a wait for an `on.<source>.<type>` event need the relay client. If it is down and the history holds nothing yet, the wait starts it (`relay.yml` must exist, see `queue relay --help`), and the relay stops itself 30 s after the last such wait ended. A relay started with `queue relay start` is never stopped automatically.

The relay does not replay events missed while it was down: a wait only sees events that arrive while it is connected.

### Repositories the relay does not cover

A GitHub webhook only covers the repositories of its owner, and the relay is configured for the organisation only. The repositories of the personal account are deliberately not relayed: `queue wait ci` on one of them ends with exit 3 ("No workflow_run delivery from <owner>/<repo> reached the relay"), whatever the CI does. That is expected, not a fault of the relay or of the webhook. For those repositories do not use `queue wait ci`: poll the run with the GitHub tools (`gh run list --commit <sha>`, or the GitHub MCP tools, see the `poll-event` skill).

## Exit codes

| Command | 0 | 1 | 2 | 3 | 4 |
|---------|---|---|---|---|---|
| `wait <event>` | matched | - | timeout (`--timeout`, default 30m) | - | invalid usage |
| `wait ci` | all runs `success`, `skipped` or `neutral` | a run failed, was cancelled or timed out | `--timeout` (default 30m) | no run seen for the commit, or relay not running | invalid usage |

Exit 2 and 3 print the likely causes and `gh run list --commit <sha>` as a cross-check; GitHub does not redeliver lost webhooks.
