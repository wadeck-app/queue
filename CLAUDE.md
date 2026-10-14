## CLI Development Workflow

`queue-cli` is installed globally via CI (GitHub Packages). To deploy a change: `git commit` + `git push` → CI publishes → `queue cli update` installs the new version. Never edit `node_modules` directly.

This is an npm workspace (`packages/queue-core`, `packages/queue-cli`, `packages/queue-relay-client`, `packages/plugin-github`, `packages/app-module-queue`). `app-module-queue` is an app-core module, not an importable library: app-core loads it through `manifest.json` (`backendEntryPath`) and it serves the dashboard routes (status/history/replay/dlq/subscribers/push) under `/api/modules/queue/` — it depends on `@wadeck-app/queue-core` directly, never on `queue-cli`. `queue-relay-client` connects to the webhook relay and pushes events into the daemon; it stays source-agnostic, source plugins (`plugin-github`) are separate packages registered as built-in plugins by the CLI's bundled relay daemon (`queue-relay-daemon.cjs`). Each sub-package's workspace link to `queue-core` resolves to its compiled `dist/`, not source — their `pretest` scripts rebuild `queue-core` automatically, so `npm test` works standalone on a fresh clone from the root or any `packages/*` dir.

## Knowledge base

- Project lessons: `.claude/kb/lessons-learned.md` — add entries with the `kb` skill or by editing directly.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | WAL/config/retry contracts + test workflow lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover |
| `.claude/product-vision.md` | Architecture + known gaps table |
| `.claude/threat-model.md` | `subscribers.yml` command injection, WAL data leakage |
