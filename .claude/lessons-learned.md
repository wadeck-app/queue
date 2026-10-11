# Lessons learned

<!-- Last updated: 2026-10-10T16:47:58.904Z -->

## Recurring feedback

<!-- session 70152cda 2026-10-10 -->
- Cross-project architecture investigation (14:32:36 onwards) required 20+ distinct bash/read queries; would benefit from delegating to Explore agent for broader codebase scans before deep-dive
- Multiple `AskUserQuestion` calls (14:18:59, 14:21:40, 16:04:15) for `queue replay` scope and retention strategy; user had to clarify mid-implementation—requirements should be in threat-model.md or product-vision.md beforehand

<!-- session 794910cd 2026-10-04 -->
- User suspicious about background automation ("est-ce que c'est toi qui a lancé des terminaux ???")—shows preference for explicit, visible control over unintended side effects.

<!-- session 9c432ada 2026-09-13 -->
- End-to-end testing with the actual installed binary after CI publish is a hard requirement, not optional; agent must verify binary is functional before running behavior tests

<!-- session 1040e8f1 2026-09-06 -->
- User explicitly requires end-to-end testing with the actual installed binary after feature implementation (not just CI passing + unit tests). User gave direct correction in French with emotion: "RUN TOI MEME, je t'ai dit que tu devais tester avec le binaire !" — this is a strong signal to test real behavior before claiming success.

<!-- session fc6d12b0 2026-09-05 -->
- Documentation improvements (enriching `--help` text) naturally cascade across related projects once the pattern is established in one place; scope often expands from single project to all similar CLIs.

<!-- session 71e5f812 2026-09-02 -->
- Help text strings in enhancements triggered linting rules (em-dashes violating `no-em-dash` rule, caught at CI time, not locally)—validate generated content against project violations before commit.
- Moving daemon startup message from stdout to stderr triggered cascading test updates across `QueueIndex.integration.test.ts` and `QueueCli.test.ts`; indicates brittleness in tests coupled to output streams rather than exit codes/behaviors.
- Multiple iterations fixing unknown subcommand error handling in sub group (`"Usage: queue sub"` message appeared twice); incomplete refactoring + insufficient test coverage for error paths.
- Windows hidden-process pattern (wscript.exe SW_HIDE) required external reference doc; could benefit from prominence in binary-bundling/CI documentation.
- Manual E2E test cycle needed after each deployment: daemon lifecycle (start/stop), event push/delivery, DLQ checks, and dispatch log verification.

## Agent errors

<!-- session 06998243 2026-10-10 -->
- Assistant's own response to format correction was incomplete/malformed, stopping mid-sentence instead of providing a complete finding

<!-- session 70152cda 2026-10-10 -->
- MCP `mcp__github-wadeck-app__actions_list` repeatedly marked "NOT YET KNOWN" (14:14:27, 14:26:42, 14:49:10, 16:10:16, 16:11:04, 16:11:26)—called before schema fetched; should use ToolSearch or load schemas upfront

<!-- session 794910cd 2026-10-04 -->
- Initial exploration found no "flow history" command existed (user assumed it), correctly identifying this as net-new feature not copy-paste task.
- Attempted to invoke poll-ci skill and mcp__github-wadeck-app__actions_list tools without first fetching their schemas via ToolSearch; repeated "NOT YET KNOWN" warnings, then fell back to inefficient sleep loops for CI polling instead of diagnosing the schema issue.

<!-- session 733435a3 2026-10-04 -->
- Session asked (in French) "Comment doit s'appeler/se placer la commande?" during planning, suggesting Explore agent's codebase scan did not clarify existing command naming/placement patterns clearly enough to avoid mid-task clarification need.

<!-- session 2c334846 2026-10-04 -->
- Spawning multiple parallel fork agents for independent tasks (violations check, CI polling, manual test, violation fixes) created coordination friction; results tracking and completion sequencing unclear without explicit polling.

<!-- session 5fef0bd5 2026-10-04 -->
- Code-review fork validated tests but skipped violations check, missing 51 violations (Unicode symbols, unsafe casts, em-dashes) — false "all KEEP" verdict masked real issues
- Manual-test fork spent excessive effort discovering queue CLI interface (binary paths, --cli-foreground flag, daemon startup) — behavior not well-surfaced for testing

<!-- session 05e37d0a 2026-09-13 -->
- Review fork missed 51 violations (Unicode symbols, unsafe casts, em-dashes) — review validated tests pass but did not run violations check, leading to false "all KEEP" verdict
- Manual test fork struggled with daemon lifecycle verification and queue CLI invocation path — tried multiple command paths and daemon status approaches before settling on the correct pattern

<!-- session 9c432ada 2026-09-13 -->
- manual-test agent called skills before schemas were loaded (parallel-and-todos, violations, poll-ci marked "NOT YET KNOWN"), causing workflow friction; should fetch tool schemas before spawning sub-agents

<!-- session 1040e8f1 2026-09-06 -->
- When implementing subscriber/dispatch features, the full test cycle is: (1) unit tests + CI, (2) `queue cli update` to install new binary, (3) daemon bounce (`queue stop` then push to auto-start), (4) end-to-end test with actual binary. Unit tests + CI passing alone is insufficient — the daemon must be restarted to pick up code changes.

<!-- session fc6d12b0 2026-09-05 -->
- When CLI `--help` is unavailable via pipe context (not TTY), read the source code (help text generation) directly rather than trying different CLI invocation approaches.
- Em-dashes and smart characters in CLI help text enrichment need post-processing validation—check grep for "—" and "–" after documentation edits.
- Using `sleep` for CI polling instead of `poll-ci` skill — unnecessary waits and token waste. Multiple sleep intervals (sleep 8, sleep 20) suggest this pattern is re-occurring.
- Forked subagent (`a42e:fork`) committed test file directly to violations-framework while main session was on queue project — unclear if intentional work split or scope bleed from context.

<!-- session 71e5f812 2026-09-02 -->
- Replaced `cliLogsCommand` calls with `queueLogsCommand` helpers but didn't update test mocks initially; `QueueCli.test.ts` was still mocking the old function name, causing test failures to cascade.
- Mock in `QueueCommands.test.ts` returned `{ status: 'queued' }` without `subscriberCount` property; downstream code treated undefined `subscriberCount` as 0, writing `[warn]` instead of expected `[ok]`. Mock data didn't reflect real API contract.
- Blocked tool loads: poll-ci skill and mcp__github-wadeck-app__actions_list showed "NOT YET KNOWN" warnings, forcing fallback to manual `sleep` polling loops instead of automated CI monitoring.

## Documentation gaps

<!-- session 06998243 2026-10-10 -->
- Queue CLI invocation path on Windows: direct `node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` was needed when wrapper commands failed — platform-specific CLI behavior not documented
- code-review skill parameter syntax unclear: first invoked as `main...HEAD medium`, then as `397c9af..a63b529 medium` — suggests inconsistent or undocumented parameter format

<!-- session 794910cd 2026-10-04 -->
- User required clarification on the three journal entry types (`trigger`, `outcome`, `filtered`)—design intent wasn't self-evident from plan alone.
- poll-ci skill prerequisites and schema-loading requirements not documented; MCP deferred tools listed but not automatically loaded — unclear if ToolSearch fetch is mandatory before first use.

<!-- session 733435a3 2026-10-04 -->
- Queue CLI invocation path on Windows needs explicit documentation: direct `node` invocation to `/c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` was needed after wrapper scripts (`queue` / `queue.cmd`) failed; canonical path and invocation hierarchy not clear to session.

<!-- session c0efb023 2026-10-04 -->
- Plan file creation followed `.claude/plans/YYYY-MM-DD_name.md` format per project instructions, but no indication user was aware of this requirement beforehand — pattern should be documented in onboarding or CLAUDE.md.

<!-- session 2c334846 2026-10-04 -->
- Skills `violations`, `poll-ci`, and `parallel-and-todos` flagged as "NOT YET KNOWN" on first invocation despite being available, requiring ToolSearch fallback; skill pre-discovery needed to reduce discovery round-trips in parallel workflows.

<!-- session 5fef0bd5 2026-10-04 -->
- Skills (violations, poll-ci, parallel-and-todos) reported as "NOT YET KNOWN" during session; agents had to work around missing skill definitions

<!-- session 05e37d0a 2026-09-13 -->
- Queue CLI programmatic invocation path not discoverable — subprocess tried 6+ different paths before finding `/c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js`
- Subscribers.yml root key requirement not obvious — first test attempt omitted `subscribers:` wrapper, causing silent failure
- No documented procedure for invoking installed queue-cli from isolated test directories; manual testing required 15+ trial invocations trying different paths (queue, queue.js, node /c/App/nodejs/..., npm list) before finding working method

<!-- session 9c432ada 2026-09-13 -->
- Path resolution for queue CLI on Windows is fragile (tried `/c/App/nodejs/queue`, `queue.cmd`, `/c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js`); unclear which is canonical and how to verify it worked

<!-- session fc6d12b0 2026-09-05 -->
- Env var naming conventions in shared libraries (e.g., `FLOW_CONFIG` → `ConfigDir.get('flow')`) are not self-evident; agents need to read helper code and git history to infer the pattern.
- MCP GitHub actions methods show `*** NOT YET KNOWN ***` for `list_workflow_runs` and `list_workflow_jobs` — schema may be incomplete or agent unfamiliar with available method signatures on actions API.

<!-- session 71e5f812 2026-09-02 -->
- New violations rules require a corresponding test file (`src/rules/[category]/[rule].test.ts`), or self-check fails with no clear error message pointing to the root cause.

## Known constraints

<!-- session 70152cda 2026-10-10 -->
- Global npm package (@wadeck-app/queue-cli) from MSYS2 bash in arbitrary working directories: `queue` command unreliable; fallback to full path `node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` when testing CLI across different dirs
- After git push, assistant repeatedly used manual `sleep` + polling instead of `poll-ci` skill (14:27:33, 16:10:12, 16:11:00); skill available and designed for exactly this

<!-- session 794910cd 2026-10-04 -->
- Local `tsc --noEmit` passed but CI failed with TS2554 (missing `warnUnknownArgs` in `shared-cli`)—root cause was outdated package version in lock file, only caught by CI with different node_modules state.
- queue CLI requires `--cli-foreground` flag to work properly in test scenarios; test directory existence needs defensive verification before use.

<!-- session 61adf3ac 2026-10-04 -->
- Queue CLI wrapper script (`queue` command) may not be immediately available or functional on Windows after CI publishes; direct node invocation (`node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js`) works as a workaround but adds friction to manual testing workflows. Consider adding a startup check or delay in CI publish, or documenting the workaround.

<!-- session d269cf36 2026-10-04 -->
- shared-cli dependency pinning (warnUnknownArgs valueFlags) is a recurring pattern — discovered post-feature commit, required follow-up fix. Dependency verification should be integrated earlier in planning.

<!-- session 733435a3 2026-10-04 -->
- Global queue CLI update cycle shows friction: after git push + CI wait, multiple attempts to verify/update version via `queue cli version` / `queue cli update` before falling back to direct node invocation; wrapper script reliability or version-check flow may need audit.

<!-- session c0efb023 2026-10-04 -->
- Global npm package (@wadeck-app/queue-cli) from MSYS2 bash in arbitrary working directories: `queue` command unreliable; fallback to full path `node /c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` works reliably.
- GitHub Actions MCP tools (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs) fail with permission/auth issues in this session; CI monitoring fell back to polling with sleep instead.

<!-- session 3c0fed55 2026-10-04 -->
- Queue CLI may not be immediately runnable in shell after `queue cli update` on Windows; manual-test agent retried the same push tests 4+ times before realizing the binary was unavailable, then fell back to `node node_modules/@wadeck-app/queue-cli/bin/queue.js`. Verify CLI is executable before running integration tests, not after multiple failures.

<!-- session 2c334846 2026-10-04 -->
- Global npm package (@wadeck-app/queue-cli) from MSYS2 bash in arbitrary working directories: simple `queue` command unreliable, fallback to `/c/App/nodejs/node_modules/@wadeck-app/queue-cli/bin/queue.js` with full node path required for consistency.

<!-- session 5fef0bd5 2026-10-04 -->
- Violations in dist-types/ (generated .d.ts files) needed explicit exclusion in config; em-dashes in JSDoc comments trigger no-emoji violations

<!-- session 05e37d0a 2026-09-13 -->
- Review fork cannot validate violations rules — only full npm test + violations check catches code quality issues; review-only approach misses them
- Global npm package invocation (@wadeck-app/queue-cli) from MSYS2 shell with arbitrary working directories requires understanding /c/App/nodejs path mapping; direct `queue` command may not be available or may fail depending on temp directory context

<!-- session 9c432ada 2026-09-13 -->
- Queue CLI installation/update may not complete synchronously on Windows; manual-test agent retried same push test 4+ times instead of verifying `queue` binary was actually runnable first (should fail-fast if binary missing/broken, not retry the test)

<!-- session 1040e8f1 2026-09-06 -->
- Windows path normalization: `tmpdir()` returns backslashes but YAML/config parsing may use forward slashes. Tests need to normalize paths when storing in YAML or comparing resolved paths.
- Queue CLI daemon has TTY auto-detection. In non-TTY contexts (scripts, redirected I/O), use `--cli-foreground` flag; otherwise commands may hang or fail silently.
- Daemon context is sticky: `QUEUE_PUSH_CWD` env var determines which project's `subscribers.yml` the daemon loads. When testing multiple projects, either set this var or ensure daemon is scoped to the right project cwd.

<!-- session fc6d12b0 2026-09-05 -->
- GitHub Actions MCP tools (`actions_list`, `get_job_logs`) have schema/reliability issues ("*** NOT YET KNOWN ***" warnings); require retry loops with sleep intervals.
- Test runners output different failure formats; grep-based detection requires multiple patterns or switching to runner-specific queries.

<!-- session 71e5f812 2026-09-02 -->
- Go launcher (task/flow CLIs) swallows stdout when stdin is a pipe; help output unavailable via normal `--help` invocation—workaround is reading bundled source directly.
- Manual validation using `QUEUE_CONFIG_DIR=/tmp/queue-manual-test` with real bundled binary was necessary to catch UX issues (DLQ bug, subscriber count in push output, status display uptime/PID) that unit tests didn't cover.
- Real binary testing (npm install -g + CLI invocation) required for daemon/process spawning changes; unit tests insufficient for Windows TTY/hidden-process behavior.
- Package distribution step must explicitly verify all binaries included (queue-daemon.cjs was missing from published packages, discovered only when testing real installed binary).
