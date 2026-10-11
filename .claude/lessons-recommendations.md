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
