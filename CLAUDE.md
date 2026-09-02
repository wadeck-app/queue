## CLI Development Workflow

`queue-cli` is installed globally via CI (GitHub Packages). To deploy a change: `git commit` + `git push` → CI publishes → `queue cli update` installs the new version. Never edit `node_modules` directly.

## Knowledge base

- Project lessons: `.claude/kb/lessons-learned.md` — add entries with the `kb` skill or by editing directly.
