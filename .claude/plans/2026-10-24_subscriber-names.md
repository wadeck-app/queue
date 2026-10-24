# Subscriber names: say who listens to what

Status: proposal. Step 1 (optional `name`) starts after the other agents had a chance to object; step 2 (required) comes after that.

## Why

Today a subscriber is identified by `<event pattern>[<index>]` (`onFoo[0]`), built in `ConfigLoader.toResolved`. Facts from the code:

- The index is the position in the list of one file, so it changes when an entry is added, removed or reordered. The WAL, the DLQ, the history outcomes and the logs all store that string; `retry` finds the subscriber again with `s.subscriberId === entry.subscriberId` (QueueService), so after an edit a pending retry can run a different subscriber, or fail with "no longer exists".
- The index restarts at 0 in each file and the global and the project lists are concatenated: a global and a project subscriber on the same event pattern are both `onFoo[0]`. The daemon keys its WAL entries by `subscriberId` (`walEntries.set(sub.subscriberId, ...)`), so the two share one entry. Read from the code, not yet reproduced; step 1 starts with a failing test.
- `onTaskCreated[0]` says nothing to a person reading the dashboard, the DLQ or the history.

## Design

| Step | What |
|---|---|
| 1 | `name:` is optional on a subscriber in `subscribers.yml`. `subscriberId` is the name when there is one, else the legacy `<event>[<index>]`. Nothing changes for files without names |
| 1 | A name is unique inside its file for the event it listens to; a duplicate is an error at load with the file, the line of the entry and the fix. The id stored in the WAL, the DLQ, the history and the logs carries the scope so that a global and a project subscriber with the same name stay distinct: `<name>` for the global file, `<project name>/<name>` for a project file (the project name is the nearest folder with a `.queue`, as the history already records it); once project-sdk exists the project name becomes the project id (agreed with project-owner) |
| 1 | No project or owner field in subscribers.yml: the scope comes from where the file lives, so a copied file cannot claim another project (project-owner) |
| 1 | Resolved subscribers keep `legacyId` (`<event>[<index>]`) so an in-flight WAL entry, a DLQ entry or an old history line written before the name still resolves to the right subscriber |
| 1 | Shown everywhere a subscriber is shown: `queue sub list` (name column), `queue sub add --name`, `queue sub edit|remove --name` next to `--index`, `queue history`, the dashboard Subscribers, History, DLQ, Pending and Logs pages; `list-subscribers` and the routes gain a `name` field (additive, protocol 1.x) |
| 1 | Unnamed subscribers get a visible nudge (`unnamed` marker), not an error |
| 2 | Name required: loading a file with an unnamed subscriber fails loudly with `queue sub migrate-names` as the fix; the command writes `<event>-<index>` names into the file, and `legacyId` keeps the pending entries working |
| 2 | Protocol change: none for `push`; `list-subscribers` already carries the field |

Name format: `[a-z0-9][a-z0-9._-]*`, at most 64 characters (it appears in file names, URLs and logs).

## Who to ask

- project-owner: subscribers will be stored per project in their registry (Q31); a name is the natural key there.
- claude-owner: the poll-event skill and the docs that show subscribers.yml.
- orchestrator, task, flow: any subscribers.yml snippet they document or generate.

## Tests (TDD)

Duplicate ids across the global and the project file (the failing test that shows the collision), reorder safety of a pending retry, `legacyId` matching, name validation, duplicate names, CLI flags, dashboard column, history and DLQ display.
