## CLI Development Workflow

`queue-cli` is installed globally via CI (GitHub Packages). To deploy a change: `git commit` + `git push` → CI publishes → `queue cli update` installs the new version. Never edit `node_modules` directly.

This is an npm workspace (`packages/queue-core`, `packages/queue-cli`, `packages/app-module-queue`). `app-module-queue` is the library API (status/history/replay/dlq/subscribers/push) consumed by app-core's plugin dashboard — it depends on `@wadeck-app/queue-core` directly, never on `queue-cli`. Each sub-package's workspace link to `queue-core` resolves to its compiled `dist/`, not source — their `pretest` scripts rebuild `queue-core` automatically, so `npm test` works standalone on a fresh clone from the root or any `packages/*` dir.

## Knowledge base

- Project lessons: `.claude/kb/lessons-learned.md` — add entries with the `kb` skill or by editing directly.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | WAL/config/retry contracts + test workflow lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover |
| `.claude/product-vision.md` | Architecture + known gaps table |
| `.claude/threat-model.md` | `subscribers.yml` command injection, WAL data leakage |
