# Queue: remaining work after 2026-10-25

State at the end of the session: `queue-cli@2026.10.25-221-3efae3a2` installed, commit `57ba756` pushed (CI not yet read). The WAL and the DLQ of the real queue were emptied on request (69 stale test entries moved to the DLQ and cleared; 3 layout fixtures given up and cleared). The running daemon is pid 7912 on release 221.

## Done and verified live (do not redo)

- Event page `/modules/queue/events/:name`: description, facts badges, source badge, editable payload with Validate (ajv, problems table) and a rocket enabled only for the validated current text, schema, filterable fields, wait command. Seen working at `http://localhost:5173/modules/queue/events/onTaskCreated`.
- Pending page: stuck warning in a card with its action, row actions first, state+attempts in one cell, last error and whole id in the expanded row (checked at 1400, 1000 and 800 px).
- `queue wait`: several events (`--all`/`--any`), 30m default for events AND for `wait ci` (one constant `WAIT_DEFAULT_TIMEOUT`).
- Subscriber names (optional `name`, ids `<name>` global / `<project id>/<name>` project, `legacyId`, warnings, `sub edit --name` alone). No migration command, by the user's decision.
- project-sdk: registry lookup per push, `projectId` in history/WAL/DLQ meta, protocol 1.2.0 `project`, `queue push --project|-p`, `QUEUE_PROJECT`, SDK `project` option, `--project` on `queue history` and `queue dlq list`, subscribers read from `projectToolDir(...,'queue','config')` (parents too), `--scope project` writes there.
- Daemon/CLI version mismatch warning; dev-build guard from shared-cli; `wait ci` exit-3 diagnostic; docs note that the personal GitHub account is deliberately not relayed.

## To do, in this order

1. Read the CI of `57ba756`, then `queue cli update`.
2. Remove the walk-up of `.queue/subscribers.yml` for good: make it a loud error naming the file and its destination (condition: no legacy file in use; project-owner already moved the two known ones). Remove `meta.projectName`-from-folder only if the user decides (users write `when: meta.projectName=...`).
3. `--project` on `queue status` (counts filtered by `meta.projectId`); project selector in the History/DLQ dashboard pages (today only the URL parameter).
4. queue-sdk contract fixture for `project` (the contract harness has no registry; add one).
5. Step 2 of the subscriber names, once the user has named the subscribers of the real config by hand: unnamed subscriber fails to load with the file, the entry and `queue sub edit <event> --index N --name <name>`; then drop `legacyId` and the legacy-id lookup of retry.
6. Entries written with the old `<folder>/` id prefix are no longer found after the switch to `<project id>/`: nothing planned (only stale test entries); decide if that is acceptable.
7. Dashboard: Top Events keeps ~100 px of blank under its table (a DataTable never stretches); other widgets fill their tile.

## Decisions waiting for the user

- Stop the running daemon after an update automatically? Today only a warning (`queue stop` is manual).
- A webhook for the personal GitHub account, or keep polling with `gh run list` (current choice: not relayed on purpose).
- Click the "Give up all the stuck events" bulk button on real data (it works; the stale data is gone).

## Working notes (what cost time)

- Hooks: no `node -e` (blocked), no `rm` of files not created in the session (move them), no inline `eval`; write scripts with the Write tool, not heredocs containing `\\n` (the shell layer turns it into a real newline); sed with `\n` has the same problem, use the Edit tool.
- Never chain `git commit && git push` after a test run with `;` (it pushed a red test once); use `&&`.
- `git-commit-push` needs the user to run `/w-guardrails:request-bypass-gcp4h` when it expires (4 h).
- Lockfile pins win over `latest`: bump one entry with `npm install <pkg>@latest -w <workspace>`, then restore `"latest"` in `package.json` and the lock spec.
- Visual checks: register the WIP module with `curl -X POST http://127.0.0.1:4850/api/modules/register` right before the screenshot (a daemon restart or `queue cli update` re-registers the published one); agent-browser needs a `snapshot -i` before refs exist; wait ~10 s after `open`.
- A daemon stops itself when the WAL is empty; after a CLI update the running daemon keeps the old code until `queue stop`.
- Do not run `queue wait ci` for the personal account repositories (exit 3 is expected).

## Prompt to paste after /clear

```
Tu reprends le travail du repo queue (C:\Workspace_Tooling\queue), session précédente: queue-owner. Lis d'abord .claude/plans/2026-10-25_remaining-work.md (état, ordre des tâches, décisions en attente, pièges de l'environnement), puis CLAUDE.md du projet et celui de l'utilisateur. Réponds en français avec accents; code et docs en anglais. Travaille en TDD, vérifie chaque changement d'interface dans le navigateur avec agent-browser (réenregistre le module WIP juste avant), lance npm test et violations check avant chaque commit, enchaîne commit/push avec &&, puis attends la CI avec queue wait ci <sha> --cli-foreground en arrière-plan et fais queue cli update quand elle est verte. Commence par la tâche 1 de la liste, puis continue dans l'ordre sans demander mon accord sauf pour les décisions listées comme en attente. Si la dérogation git-commit-push a expiré, dis-le moi: je lance /w-guardrails:request-bypass-gcp4h.
```
