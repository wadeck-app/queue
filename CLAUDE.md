## CLI Development Workflow

`queue-cli` is installed globally via CI (GitHub Packages). To deploy a change: `git commit` + `git push` -> CI publishes -> `queue cli update` installs the new version. Never edit `node_modules` directly.

This is an npm workspace (`packages/queue-sdk`, `packages/queue-core`, `packages/queue-cli`, `packages/queue-relay-client`, `packages/plugin-github`, `packages/app-module-queue`). `queue-sdk` (`@wadeck-app/queue-sdk`, published to GitHub Packages with the CLI) is the one way for other programs to push events: zero dependencies, never throws, starts the daemon on demand through `queue start`, and negotiates the push protocol, which has its own SemVer version (`docs/push-protocol.md`; MAJOR breaking, MINOR additive; change a protocol only additively or bump the MAJOR and update `contract/protocol-1.json` in the same commit). `queue-core` imports the protocol constants from `@wadeck-app/queue-sdk/protocol`, never the reverse; the SDK must not depend on `queue-cli`. `app-module-queue` is an app-core module, not an importable library: sources live under `src/{backend,dsl-views}` with a source `manifest.json` (`"id": "queue"`), `npm run check` / `npm run bundle` run `app-core-cli check` / `package` and write the loadable artifact to `dist-module/` (gitignored); `queue-cli`'s `bundle` runs that script and copies `dist-module/` to `dist-bundle/app-module/`, which is what the daemon and `queue cli update` register. It serves the dashboard routes (`status`, `activity`, `activity/series`, `outcomes`, `breakdown`, `pending`, `history`, `replay`, `logs`, `events`, `events/:name/push-test`, `retry`, `pending/:id/give-up`, `daemon`, `relay`, `relay/webhooks`, `relay/deliveries`, `dlq`, `subscribers`, `push`), shown by eight pages (overview, history, events, pending, DLQ, subscribers, webhooks, logs) four dashboard widgets (status, activity, outcomes, top events) and a relay connected/disconnected badge in the navbar slot, under `/api/modules/queue/`: reads, DLQ clearing and giving up a stuck event (it moves to the DLQ) go straight to the queue files through `queue-core`, only `push`, `events/:name/push-test`, `replay`, `retry` and `dlq-replay` go through the daemon. It depends on `@wadeck-app/queue-core` directly, never on `queue-cli`. `queue-relay-client` connects to the webhook relay and pushes events into the daemon; it stays source-agnostic, source plugins (`plugin-github`) are separate packages registered as built-in plugins by the CLI's bundled relay daemon (`queue-relay-daemon.cjs`); a plugin also writes the one-line summary of its own deliveries (`RelayPlugin.summarize`), so the relay client holds no source-specific code. Each sub-package's workspace link to `queue-core` resolves to its compiled `dist/`, not source - their `pretest` scripts rebuild `queue-core` automatically, so `npm test` works standalone on a fresh clone from the root or any `packages/*` dir.

## Auto-update and dev builds

`queue-cli` self-updates through `@wadeck-app/shared-updater` (`without-daemon`): `queue-updater.cjs` is spawned after normal runs (`createUpdateScheduler`) and by `queue cli update`. Only a CalVer version (`YYYY.MM.DD-BBB-xxxxxxxx`, `isCalVer`) may update the global install: any other bundle (`0.1.0-dev`, `BUNDLE_VERSION=0.0.0-test-integration`, local bundler output) makes `queue cli update` exit 1 with an explanation, and the updater and scheduler do nothing. Any test that spawns the bundle must use `createIsolatedCliEnv()` (`src/testing/isolatedCliEnv.ts`), never `process.env` directly. An interrupted install leaves `update-state.json` at `applying`; the next updater run repairs it.

## Knowledge base

- Project lessons: `.claude/kb/lessons-learned.md` - add entries with the `kb` skill or by editing directly.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | WAL/config/retry contracts + test workflow lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover |
| `.claude/product-vision.md` | Architecture + known gaps table |
| `.claude/threat-model.md` | `subscribers.yml` command injection, WAL data leakage |
