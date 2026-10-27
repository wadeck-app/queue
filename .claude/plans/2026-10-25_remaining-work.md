# Queue: remaining work after 2026-10-25 (second session)

State (2026-10-27): `queue-cli@2026.10.27-235-ba9d6b9a` installed, CI green up to `ba9d6b9`, push protocol 1.4.0. Nothing is in progress. Daemon stopped after the update (starts on the next push).

## Done and verified (do not redo)

- Event page, Pending page, `queue wait` (several events, 30m default), subscriber names, project-sdk integration (registry lookup, `projectId` everywhere, protocol 1.2.0 `project`), version-mismatch warning, `wait ci` diagnostics: see git log.
- A `.queue/subscribers.yml` above the cwd is no longer read: `ConfigLoader` throws an error naming the file and its destination; `queue sub --scope project` outside a registered project refuses (`71bd3b5`).
- `queue status --project`; project selector on the History and DLQ pages (`GET /projects`) (`058603c`).
- Push contract fixture covers `project` (`8f33fc1`).
- Top Events shows 10 events and fills its tile (`4d63406`). With fewer events the blank under the table returns: a DataTable does not stretch.

- Subscriber names are required (an unnamed one fails to load); the real config was cleaned and named (`8c220c5`).
- Decision #29 of project-owner, all three parts, protocol 1.3.0 then 1.4.0: a subscriber runs from the main folder of the project that owns its file; a virtual project (no path) emits events without cwd (`--project`, SDK `cwd: null`); `direction` = `to-parents` (default) / `to-children` (repeatable `--direction`, SDK array); a descendant's subscriber is filed under the descendant (`meta.projectId`, `emitterProjectId`); `to-children` is refused on `before*` and on an event of no registered project; replay keeps the direction (`434de36`, `0d01303`).
- History outcome/filtered records carry the project they were dispatched under, so `queue history --project` finds an event under every project it ran in (`ba9d6b9`). Subscribers of an ANCESTOR keep the emitter's project in the records (same as the WAL): an event emitted in a child is not found under the parent's id.
- The push protocol stays SemVer (negotiated by range); documented in `docs/push-protocol.md` (`6bf849b`).
- Tests no longer leave directories in %TEMP% (`dbbbe1e`): purge of old `queue-test-*`, `queue-relay-daemon-test-*`, `queue-spawn-*.vbs`, `app-module-projects-*` older than 2 h is safe.

## Decisions taken (do not reopen)

- Entries written with the old `<folder>/` id prefix are no longer found: accepted, only stale test entries existed.
- `meta.projectName` (folder name) stays: `when: meta.projectName=...` is in use.
- After an update the daemon is not stopped automatically: `queue status` and every command warn; `queue stop` is manual.
- The personal GitHub account stays unrelayed: poll with `gh run list`.
- The bulk "Give up all the stuck events" button is not clicked on real data (nothing stuck now).

## Waiting for the user

Nothing. Subscriber names are required: the real config was cleaned (test subscribers removed, backups `*.bak-2026-10-25` next to each file) and named; an unnamed subscriber fails to load with the file, the entry and the fix; `legacyId` and the legacy-id lookup of retry are gone.

## Working notes (what cost time)

- Hooks: no `node -e` (blocked, and a blocked command runs nothing), no `rm` of files not created in the session, no inline `eval`; write scripts with the Write tool, not heredocs; a `\\n` in a bash command becomes a real newline, and so does `\n` written through a generated script: edit the final file with the Edit tool.
- Never chain `git commit && git push` after a test run with `;`; use `&&`.
- `git-commit-push` expires after 4 h: request it again yourself (step 1 without `--token`, then step 2 with the token the hook prints); the user asked for that.
- Temp scripts: write them with the Write tool under %TEMP% with a name prefixed `queue-` (other sessions reuse `editN.mjs`); never `python`, never `node -e`.
- Lockfile pins win over `latest`: bump one entry with `npm install <pkg>@latest -w <workspace>`, then restore `"latest"` in `package.json` and the lock spec.
- Visual checks: `BUNDLE_VERSION=0.0.0-wip npm run bundle` in `packages/app-module-queue`, then `POST http://127.0.0.1:4850/api/modules/register` with `{"id":"queue","source":{"type":"file","path":"<abs>/dist-module/manifest.json"}}`; `queue cli update` re-registers the published one. agent-browser needs a `snapshot -i` before refs exist; wait ~10 s after `open`; always `close` the session.
- `queue cli update`, `queue --version` and `queue wait ci` need `--cli-foreground` to print anything when stdin is not a TTY. `queue wait` takes durations like `15m`, not bare numbers.
- The registry CLI is `project` (not `queue project`); `project show` lists a project's tool folders.
- Tests of the CLI that read the registry set `XDG_CONFIG_HOME` to a temp dir.
- A daemon stops itself when the WAL is empty; after a CLI update the running daemon keeps the old code until `queue stop`.
- Do not run `queue wait ci` for the personal account repositories (exit 3 is expected).
