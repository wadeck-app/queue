## CLI Development Workflow

`queue-cli` is installed globally via CI (GitHub Packages). To deploy a change: `git commit` + `git push` → CI publishes → `queue cli update` installs the new version. Never edit `node_modules` directly.

This is an npm workspace (`packages/queue-core`, `packages/queue-cli`). On a fresh clone, run `npm run build` before `npm test` — `queue-cli`'s workspace link to `queue-core` resolves to its compiled `dist/`, not source.

## Knowledge base

- Project lessons: `.claude/kb/lessons-learned.md` — add entries with the `kb` skill or by editing directly.

## Agent reference docs

| Doc | Description |
|---|---|
| `.claude/guiding-principles.md` | WAL/config/retry contracts + test workflow lessons |
| `.claude/out-of-scope.md` | What this project explicitly does not cover |
| `.claude/product-vision.md` | Architecture + known gaps table |
| `.claude/threat-model.md` | `subscribers.yml` command injection, WAL data leakage |
