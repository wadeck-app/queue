# Recommendations

<!-- consolidated 2026-09-05 -->
**Documentation**
- [ ] Document the manual E2E test checklist (daemon start/stop, event push/delivery, DLQ checks, dispatch log) in a `docs/testing.md` or `CLAUDE.md` so it is not rediscovered each session.
- [ ] Add a note in binary-bundling/CI docs that all binaries must be explicitly listed for inclusion in the published package (e.g. `queue-daemon.cjs`).
- [ ] Add a note to violations docs that every new rule requires a matching test file at `src/rules/[category]/[rule].test.ts` or the self-check fails silently.

**Process**
- [ ] Run `npx violations check` (or equivalent) locally before committing any generated or authored strings to catch rule violations (em-dash, etc.) before CI.
- [ ] After any stdout/stderr stream change in daemon or CLI output, grep for tests asserting on that exact string and update them in the same commit.
- [ ] Before publishing, run a smoke test of the real installed binary (`npm install -g` + CLI invocation) for any change touching daemon lifecycle, TTY detection, or Windows process spawning.
- [ ] When refactoring a helper (e.g. renaming `cliLogsCommand` → `queueLogsCommand`), search all test files for the old name and update mocks in the same PR.

**Code comments**
- [ ] Add a comment above any mock object in tests listing the required fields from the real API contract (e.g. `subscriberCount`) so stale mocks are caught at review time.

**Configuration**
- [ ] Nothing

<!-- consolidated 2026-10-04 -->
- [ ] Document the canonical queue-cli invocation path for Windows (e.g. `/c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js`), including which of `queue`/`queue.cmd`/direct node invocation is authoritative, so agents stop trial-and-erroring 6-15 times per session.
- [ ] Document the `subscribers.yml` required root key (`subscribers:`) and other schema requirements explicitly, since omitting it fails silently.
- [ ] Document the required full test cycle for daemon/subscriber/dispatch changes: unit tests + CI → `queue cli update` → daemon bounce (`queue stop` then auto-start) → end-to-end test with the real installed binary — unit tests + CI passing is not sufficient on its own.
- [ ] Document `QUEUE_PUSH_CWD` and Windows path-normalization caveats (backslash vs forward-slash in YAML/config) for multi-project daemon testing.
- [ ] Document the TTY auto-detection behavior and the `--cli-foreground` flag requirement for non-TTY/scripted contexts.
- [ ] Document that new violations rules require a matching test file at `src/rules/[category]/[rule].test.ts`, since the current failure gives no clear pointer to this requirement.
- [ ] Document the Windows hidden-process / Go-launcher stdout-swallowing-on-piped-stdin quirk and the workaround (reading bundled help source directly) in the CLI reference docs.

- [ ] Require any code-review or "review-only" pass to also run `npm test` + the violations check before issuing a KEEP/pass verdict — a review that only reads the diff misses lint/violation classes of bugs (Unicode symbols, unsafe casts, em-dashes).
- [ ] Before running manual/E2E tests, fail-fast by verifying the installed binary actually runs (version/health check) rather than retrying the same failing test multiple times.
- [ ] When moving CLI output between streams (stdout/stderr) or renaming helper functions, grep for all test mocks/assertions referencing the old name/stream in the same change, rather than discovering cascading failures incrementally.
- [ ] Before spawning sub-agents (manual-test, review forks, etc.), pre-load required tool/skill schemas via ToolSearch so the sub-agent doesn't start with "NOT YET KNOWN" tools.

- [ ] Add a post-edit grep check for em-dashes/smart characters (`—`, `–`) whenever CLI help text or other user-facing strings are enriched, to catch `no-em-dash` violations before CI.

(No Configuration-category items were actionable/distinct enough to include beyond what's already covered above.)

<!-- consolidated 2026-10-18 -->
## Documentation

- [ ] Add a "Waiting for CI" section to the project `CLAUDE.md`. It should say: after `git push`, run `queue wait ci <sha> --cli-foreground` with `run_in_background: true` (or use the `poll-ci` skill), and never use `sleep N` loops. Sessions keep falling back to 100s sleeps even though the global `CLAUDE.md` already says this.
- [ ] Add a "Deferred tools" note to the project `CLAUDE.md`. Before calling `mcp__github-wadeck-app__*`, `SendMessage`, `ListAgents`, `EnterPlanMode` or skills like `write-doc`, run `ToolSearch select:<name>` first. A "NOT YET KNOWN" warning means load the schema, not retry blindly. If the MCP server is still connecting, fall back once instead of retrying 10+ times.
- [ ] Add a "Run the installed CLI on Windows" section to `.claude/guiding-principles.md`.
  - Canonical fallback: `node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js`.
  - In non-TTY Git Bash, use `--cli-foreground`.
  - Verify the binary runs before looping on tests.
  - Full test cycle for daemon or subscriber changes: unit tests and CI, then `queue cli update`, then `queue stop` and a push to restart the daemon, then an end-to-end test with the installed binary.
- [ ] Add an "Integration test setup" section to `.claude/guiding-principles.md`.
  - Each test needs its own `QUEUE_CONFIG_DIR` and a fresh mktemp dir.
  - Set `APP_CORE_PORT` and `APP_CORE_CONFIG_DIR` in `vitest.config.ts`.
  - Integration tests run sequentially.
  - Check ports (47910-47912, 4850-4852, 4871) with `netstat` before launch.
  - Stop spawned daemons and wait for the port to be released after `taskkill`.
  - Windows temp-dir cleanup needs retry and backoff.
  - Use forward-slash paths (`C:/...`) when registering a module manifest.
- [ ] Document the app-core module integration contract in `.claude/product-vision.md` or a new `.claude/app-module-contract.md`.
  - `api-backend/` and `dsl-frontend/` layout, `manifest.json` shape (`id`, `version`) and backend entry shape.
  - App-core caches modules by `manifest.version`, so `bundle.ts` must write the build version.
  - `@wadeck-app/app-core-sdk` ships `index.bundle.d.ts` for use outside the monorepo, and the `ModuleContext` mirror stays.
  - Check that `@wadeck-app/*` dependencies are published before adding them.
- [ ] Document the `@wadeck-app/*` dependency policy (pin vs `latest`/`*`) in one place, and record the CalVer scheme and the `compute-version` breaking-input contract.
- [ ] Document the relay contracts: the webhook API shape (`stats`, `verified24h`, history endpoint), the `relay.yml` schema, the `_secrets_/.env.local` convention, and the `QUEUE_DAEMON_SCRIPT` injection. State that token values must never appear in logs or error messages, and keep `.claude/threat-model.md` in sync when relay or secrets features change.
- [ ] Add a "Test conventions" section to `.claude/guiding-principles.md`.
  - Exclude `*.test.ts` and `*.integration.test.ts` from every package's `tsconfig.json`; pass this to delegated agents.
  - Never assert exact errno values (Windows gives `ENOENT`, Linux gives `ENOTDIR`); match with platform-aware checks.
  - Include the test file naming/`TestContext` pattern and how to seed NDJSON history fixtures.
  - Run `tsc --noEmit`, and rebuild dependent `dist/` before type-checking.
- [ ] Add the `ws` library `autoPong` behavior to the dependency notes. A dead peer must be simulated with `terminate()`, not by going silent.
- [ ] Document the `agent-browser` workflow: a one-time `agent-browser install`, use `--session <name>`, and clean up orphaned sessions with `taskkill`. Also add a fixture-generation pattern (`make.mjs`) for UI regression checks.
- [ ] Add notes on violations config: globs for nested workspace packages, new rules needing a `src/rules/<category>/<rule>.test.ts`, and the ban on em-dashes in help text and JSDoc. Tell contributors to run the `violations` skill before commit, because `code-review` does not cover it.
- [ ] Update the `README` and the `queue wait ci` docs in the same commit as the feature, not at the end of the session.
- [ ] Note in `.claude/kb/lessons-learned.md` that the correct path is `.claude/kb/lessons-learned.md`. A duplicate `.claude/lessons-learned.md` exists, so delete or merge it.

## Process

- [ ] Before delegating or implementing a new command or API (for example `relay webhook list|history`, or `queue history` vs `queue cli history`), confirm the naming and the domain-vs-tooling placement with the user or against existing patterns.
- [ ] Before starting cross-repo work (app-core module layout, SDK availability), get the contract via `SendMessage` or from docs first, not mid-implementation. Check that new `@wadeck-app/*` dependencies exist on the registry.
- [ ] Give agents explicit scope and checkpoints. Delegated work like R9/R10 diverged and needed a "narrow scope" redirect. Require a test-first red state and a stated plan before multi-file edits.
- [ ] Verify delegated work directly: read the files, run the tests and `tsc`, and check that tests are not vacuous. Confirm the failure path is reachable, assert full outputs and message text, and make sure every resource is stopped on the error path.
- [ ] Search project docs (`CLAUDE.md`, `.claude/*`) before spawning broad external research agents. State the expected output and keep the question narrow, for example the GitHub `workflow_run` payload schema rather than CI systems in general.
- [ ] Test with the real installed binary after CI publish before claiming success. Tests against local builds are not end-to-end validation.
- [ ] Debug one variable at a time and require evidence (logs, state files) before stating a root cause. Check the platform constraints first, for example Infomaniak exposes no custom env vars and SSH exec loses stdout, so use `scp`.
- [ ] Apply code-review findings immediately, test-first, without asking for approval. Before reviewing, confirm the correct commit range, since `main...HEAD` can be empty after a push.
- [ ] Before deleting a module or barrel `index.ts`, grep for all importers. Search for dead code and duplicated helpers (for example repeated `isEnoent` checks) during review.
- [ ] Never run global npm installs without asking. When a script discards an input flag silently (as `compute-version.sh` did), fail loudly instead and audit similar scripts.
- [ ] When parallel agents work in the same repo, state which files each owns and what must not be staged. Sequence npm workspace operations to avoid lock contention.

## Code comments

- [ ] Add a comment above the `autoPong` heartbeat code and its tests explaining that the `ws` library auto-replies to pings, so a dead-peer test must terminate the connection.
- [ ] Add a comment above the platform-dependent errno assertions (`RelayLogger.test.ts`) explaining why both `ENOENT` and `ENOTDIR` are accepted.
- [ ] Add a comment in `bundle.ts` explaining that `manifest.version` must be written into the artifact, because app-core caches modules by it.
- [ ] Add a comment above the retained `src/moduleContext.ts` mirror explaining why it stays.
- [ ] Add a comment in the `PASSTHROUGH_FLAGS` template code saying the flags are intentionally unused at the call site.

## Configuration

- [ ] Add `*.stackdump` (`bash.exe.stackdump`) to `.gitignore`.
- [ ] Make sure every package `tsconfig.json` has `"exclude": ["**/*.test.ts", "**/*.integration.test.ts"]`. Consider a CI or lint check for it, plus a check for import-path case sensitivity.
- [ ] Add per-package `vitest.config.ts` defaults (`APP_CORE_PORT`, `APP_CORE_CONFIG_DIR`, `QUEUE_CONFIG_DIR`, sequential integration tests, explicit include/exclude so `dist/*.test.js` does not run twice).
- [ ] Pre-allow frequently bypassed commands (git-commit, kill-port, `queue wait ci`, `netstat`) in `.claude/settings.json` to cut permission-prompt friction. Fix the w-guardrails bug `checkKillSwitchWrite is not defined` in `request-bypass.js`, and note that grants are CWD-relative.
- [ ] Exclude generated `dist-types/` from the violations config, and add the `no-em-dash` check for help text to the local pre-commit step.
- [ ] Replace hardcoded absolute paths (`/c/Workspace_Tooling/...`) in integration tests with temp or relative paths.

<!-- consolidated 2026-10-18 -->
## Documentation

- [ ] In project CLAUDE.md, add a "Testing the installed CLI" section. It should give the canonical Windows invocation `node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` for when the `queue` shim fails. It should say to use `--cli-foreground` in non-TTY shells. It should say to verify the binary runs before any manual test, and to bounce the daemon (`queue stop`, then push) after `queue cli update`. It should also say that `QUEUE_PUSH_CWD` decides which `subscribers.yml` the daemon loads.
- [ ] In `.claude/guiding-principles.md`, add an "app-core module contract" section. It should cover the `api-backend/` and `dsl-frontend/` layout and the `manifest.json` schema (`"id": "queue"`, `version` as the loader cache key). It should cover the `backend.ts` and `ModuleContext` shape. It should say to use `index.bundle.d.ts` for SDK types outside the monorepo, and to register modules with forward-slash paths (`C:/...`). Add a link to this section from CLAUDE.md.
- [ ] Add a "Test environment" section to `.claude/guiding-principles.md`. It should cover per-package `vitest.config.ts` isolation (`QUEUE_CONFIG_DIR`, `APP_CORE_CONFIG_DIR`, `APP_CORE_PORT`) and sequential integration tests. It should explain how to seed NDJSON history files and how to create temp dirs. It should say to use a fresh temp dir per test and a retry/backoff for temp-dir cleanup on Windows. It should list the port ranges in use (47910-47912, 4850-4852, 4870-4871) and require a `netstat` check before launching. It should say to count `queue-spawn-*.vbs` leaks, and to use `error.code` or OS-aware assertions because ENOENT and ENOTDIR differ between Windows and Linux.
- [ ] Add a "Workspace package template" to CLAUDE.md or `.claude/guiding-principles.md`. It should include the `tsconfig.json` with `"exclude": ["**/*.test.ts", "**/*.integration.test.ts"]`, the `vitest.config.ts`, `src/index.ts`, and a `pretest` rebuild of `queue-core`. Also state that dist/ types lag source until a rebuild.
- [ ] Document the relay API contract in the `queue-relay-client` README. It should cover the webhook list/history response shape (`stats`, `verified24h`, delivery fields) and the `RelayClient`, `RelayConnectionError` and `RelayStopError` types. It should cover the `QUEUE_DAEMON_SCRIPT` injection, the stdout/stderr stream for relay daemon output, and `ws` `autoPong` with the minimum `ws` version. It should say that `daemon.stop()` and `connection.stop()` must both run before exit. Also document `_secrets_/.env.local` token loading.
- [ ] Add a short section on the `@wadeck-app/*` dependency policy. It should say whether to pin or track `latest`, and to check that a package is published (`check-npm-published`) before adding it. Add the CalVer scheme and the `compute-version` `breaking-input` behavior (now fail-loud) to the same section.
- [ ] Update `.claude/threat-model.md` to include the rule that tokens must never appear in logs, error messages or diagnostics. Include the `relay.yml` and `_secrets_` handling policy. Review it whenever a relay command is added.
- [ ] Add a "violations setup" note to `.claude/guiding-principles.md`. It should cover glob exclusions for nested workspace `node_modules` and `dist-types/`. It should say that new rules need a matching `src/rules/<category>/<rule>.test.ts`, and that rules live in repo-local `.violations/rules/`. It should warn against em-dashes in help text and JSDoc, which `no-em-dash` and `no-emoji` flag.
- [ ] Update the `queue wait ci` section of the README when the command ships, not at the end of the session. Note that the `poll-ci` SKILL.md must stay aligned with it. Also document the agent-browser fixture workflow (`make.mjs`, `agent-browser install`, `--session <name>`, close stale sessions) as a reusable pattern.
- [ ] Add Infomaniak/PM2 deployment notes covering the following:
  - The platform supervisor runs `npm start` and bypasses `ecosystem.config.cjs`.
  - Custom env vars are not exposed, so secrets must be written to files.
  - SSH exec loses stdout (exit 255), so use `scp`.
  - rsync needs a retry loop.
  - `$(...)` truncates multiline output.
  - Verify against the public domain, not the SSH host.

## Process

- [ ] Add to the project CLAUDE.md that deferred tools and skills must be loaded with `ToolSearch("select:<name>")` before the first call. This covers MCP GitHub tools, `write-doc`, `poll-ci`, `EnterPlanMode`, `AskUserQuestion` and `SendMessage`. A "NOT YET KNOWN" result means load the schema, not retry. The `github-wadeck` MCP server may still be connecting, so retry at most once and then fall back to `gh`. State that the MCP tools cannot re-run jobs.
- [ ] Reinforce in CLAUDE.md that CI waits after a push use `queue wait ci <sha> --cli-foreground` with `run_in_background: true`, never `sleep N` loops. Put it as the first line of the CI section. Also tell agents to check project docs, CLAUDE.md and skills before launching external web research. Narrow research prompts to the exact question, such as the GitHub `workflow_run` payload.
- [ ] Add a "definition of done" for features. It should cover test-first work (confirm the test fails without the fix) and `tsc --noEmit`. It should cover the violations check, and an end-to-end run against the globally installed binary after `queue cli update` and a daemon bounce. For UI or module changes, add a browser check after CI. The agent must show test evidence, such as run time and counts, not just report "pass". Review forks must run `npm test` and violations, not just read the diff.
- [ ] Add a rule for delegation briefs: list the build conventions (tsconfig test exclusion, test-first, naming) and say which files not to touch or commit. Require the final `git diff --stat` and a test run in the agent's report. Require the main session to read the changed files before reporting success. Give long async or backoff tasks an explicit scope and a checkpoint, such as "finish from the red state".
- [ ] Before implementing CLI commands or cross-repo contracts, fix the command names and layout and get approval. Examples are `relay webhook list|history`, top-level `queue history` versus `queue cli ...`, and the app-core folder layout. Get the contract confirmed with app-core-owner, with `SendMessage` and `ListAgents` loaded first, before writing code, not after.
- [ ] Add a pre-flight checklist for review and test runs. Check the diff range is non-empty (`git log origin/main..HEAD`), and the right port maps to the right instance. Check the changed ports are free, and that the `queue` binary runs before retrying tests. Do a grep audit of imports before deleting barrel files or moving modules, and run `tsc` and the tests together after the change.
- [ ] Add a pointer in CLAUDE.md to avoid `sed` for import edits and to use the Edit tool. Also say not to run global `npm install -g` without asking, and that a failing plugin hook (`checkKillSwitchWrite` undefined) must be reported, not retried.

## Code comments

- [ ] Comment the `ws` `autoPong` behavior and the reason a "dead peer" test needs `terminate()` where the heartbeat code and tests live in `RelayConnection`. Comment the abort-listener cleanup in the sleep helper.
- [ ] Comment `bundle.ts` where it writes `manifest.version` into the bundle, explaining that the app-core loader cache is keyed on it and that omitting it serves a stale module.
- [ ] Comment the platform-specific error assertions in `RelayLogger.test.ts` (ENOENT on Windows, ENOTDIR on Linux). Comment the unused `PASSTHROUGH_FLAGS` at the template call site.
- [ ] Comment the local `src/moduleContext.ts` mirror, saying why it is kept (types leak into compiled output; use `index.bundle.d.ts`).

## Configuration

- [ ] Add `*.stackdump` and `bash.exe.stackdump` to `.gitignore`, and remove the duplicated `.claude/lessons-learned.md`. The canonical file is `.claude/kb/lessons-learned.md`.
- [ ] Add the following to `.claude/settings.json`: a permission allowlist for frequent read-only commands (`netstat`, `git status/diff/log`, `queue ...`, `gh run list`), and bypass pre-approval for routine `git-commit` and `kill-port` calls (run the `fewer-permission-prompts` skill). Fix the w-guardrails `request-bypass.js` `checkKillSwitchWrite` bug and make grants independent of CWD.
- [ ] Add a lint check in CI for import-path case sensitivity (Windows vs Linux). Add a CI lint for em-dashes in help text and JSDoc, and make the `tsconfig` test exclusion the default in every package. Run the violations check in CI for review forks.
- [ ] Make each package's vitest config explicit about `include` and `exclude`, so `dist/*.test.js` artifacts do not run twice. Make test setup set `QUEUE_CONFIG_DIR` and the app-core ports by default, and replace hardcoded `/c/Workspace_Tooling/...` paths in integration tests with temp or relative paths.
