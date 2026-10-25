# Lessons learned

<!-- Last updated: 2026-10-25T20:27:54.541Z -->

## Recurring feedback

<!-- session fc140a04 2026-10-25 -->
- User corrected output format violation at start — required exact pattern matching with only four section tags.

<!-- session 53a72f6b 2026-10-25 -->
- Frequent version compatibility checks required between SDK and daemon (protocol versions, EVENT_CATALOG_MIN_VERSION, daemon version warnings) — version negotiation is complex in this system
- Temporary .mjs scripts staged in /tmp/ used for multi-step code transformations before running tests and committing — consistent pattern across multiple features
- Dependency updates to @wadeck-app/shared-cli and @wadeck-app/project-sdk required lockfile updates (17:21-17:30, 16:10) — version pinning or update automation may reduce friction.

<!-- session 4ff1a10a 2026-10-24 -->
- Async/await refactoring pattern: Multiple agents independently rewrote `rmSync()` → `await removeDir()` across several integration test files (QueueIndex.integration.test.ts, relayRead.integration.test.ts, QueueDaemon.integration.test.ts, QueueSdk.integration.test.ts) using sed. This suggests a broad requirement that should have been upfront or applied uniformly in one pass.
- Cross-team dependency sequencing: dsl-ui version block identified, plan for subscriber-names created and shared, visual testing via agent-browser after each feature bundle.

<!-- session ca620a5a 2026-10-24 -->
- Parallel agents launched for similar deflaking work across independent packages (queue-cli, queue-relay-client, queue-core, etc.) — verify no file-write races or conflicting modifications before parallelizing mass refactoring.
- Sleep-based test polling (280-290s waits between vitest runs) fragile and machine-dependent — indicates timing assumptions baked into test harness that will fail under load.
- Test-first workflow with immediate bundling and agent-browser UI verification for each feature (giveup, events, subscriber names) worked well, but required careful version coordination of external module dependencies that weren't guaranteed to be available when needed.

<!-- session 29f6efb2 2026-10-24 -->
- Multiple `queue wait ci` waits across commits (5a180bb, f3fe529, 32e8383, 52664db, 58dde7d) and repeated bundle/register cycles suggest tight feedback loops; CI cycle time or local test coverage may be worth auditing if this pattern repeats.
- Large test suites take 240+ seconds; agents use `sleep + tail` polling instead of streaming output, burning context on silent waits
- Iterative feature work uses bundle versioning (0.0.9-giveup, 0.0.9-events2, 0.0.9-md) to test changes before final commit.

<!-- session 93cf3ce8 2026-10-18 -->
- CLAUDE.md routes list (status/activity/history/replay/dlq/subscribers/push) drifted from actual implementation. Docs need sync enforcement or auto-generation.

<!-- session 0b8f766f 2026-10-18 -->
- CI wait polling uses `sleep 100/60; echo waited` + manual result checking instead of structured polling. No direct access to CI status between sleep cycles — suggests uncertain about optimal wait intervals.

<!-- session 1f6af8e0 2026-10-18 -->
- Consistent use of Read before Edit and proper `git mv` for renames; methodical file protocol; proactive delegation via SendMessage to team members instead of blocking on interdependencies
- When debugging test failures in monorepo: capture full output to /tmp/ first, then grep/isolate by workspace, rather than running workspace tests cold

<!-- session de7e2366 2026-10-18 -->
- Long CI waits (12–25 min) with polling sleeps; consider documenting expected CI times per commit type in guiding-principles.md to set expectations upfront.

<!-- session 6b2405c4 2026-10-18 -->
- Mid-task scope narrowing redirects indicate agent should checkpoint/approve approach before diverging, not after

<!-- session 19baf9ca 2026-10-17 -->
- `sleep 100` used for CI waits (09:56:08, 09:59:41, 17:28:30) instead of the documented `queue wait ci` approach referenced in CLAUDE.md; adds unnecessary delays to session.

<!-- session ce5be425 2026-10-17 -->
- Long blocking sleeps (sleep 100+) to wait for CI runs burn session wall-clock time. Later, CLAUDE.md guidance was amended to use `queue wait ci` instead of manual polling — the feature being built should have been the stopping point, not added after.

<!-- session 179c5926 2026-10-17 -->
- Output format violation — previous attempt generated lines that do not match required format; user had to re-state exact patterns allowed.

<!-- session ac4c2b8f 2026-10-17 -->
- Three parallel agents (Explore, general-purpose, claude-code-guide) spawned at 09:49:12-09:49:40 for research; extensive WebFetch calls (CI completion mechanisms across systems) but output/usage unclear from log—possible over-investment in exploratory research without clear next-step connection.

<!-- session 5ea726b4 2026-10-14 -->
- User redirected assistant to use the installed `queue` CLI directly via Bash instead of trying to invoke node -e workarounds; this is a reminder to reach for existing tools first rather than inventing alternatives.
- Windows-only test assertions (`errno`, path case) passed locally, failed only on Linux CI runs.
- YAML validation: regex patterns insufficient for structure validation; use js-yaml.load() to parse and validate schema instead.
- When reviewing code that fails verification, apply all fixes test-first rather than just reporting findings — the user expects the reviewer to ADJUST, not defer.
- Test isolation: shared temp config dir accumulates state from prior tests; each test needs separate dir or cleanup
- Multiple test refinements needed for heartbeat liveness detection: initial approach didn't account for WebSocket control frame semantics, requiring iterative debugging and test rewrites (3+ attempts) before tests behaved as expected.
- Code duplication (repeated `isEnoent` checks across error handlers) not caught in initial review — needs helper function extraction step during fix.
- When fixing workspace package type mismatches (dist/ vs source), initial @ts-expect-error attempts precede proper type casting/imports. Plan for stale dist/ types on fresh checkouts.
- Test cleanup (temp directories) required retry logic on Windows; first attempt to remove directories failed silently, forced addition of retries and backoff.
- Main agent and sub-agent coordination friction when delegating work on interdependent features; explicit handoff/pause state needed.

<!-- session 3c886490 2026-10-17 -->
- Used fixed-duration `sleep` for CI waits (100s, 110s) instead of event-driven mechanisms; later replaced with `queue wait ci` (better). Pattern: use skills like poll-ci or event commands (queue wait ci) for CI completion, not timeouts.

<!-- session 7de46642 2026-10-17 -->
- Proactive agent spawning (Explore, general-purpose, claude-code-guide in parallel at 09:49:12+) while foreground work continues shows effective delegation; verify agent results before reporting

<!-- session d9e5ed4e 2026-10-11 -->
- Agent made unverified hypotheses ("probably the name", "likely a health-check issue") instead of investigating baseline before each speculation. User had to correct diagnosis multiple times (PM2 process naming, maintenance toggle behavior).
- User corrected me multiple times about writing to project-local `.claude/kb`, not global `~/.claude/kb` — I kept reaching for the wrong directory.
- User required me to stop making unilateral decisions on open questions (mTLS was marked "Resolved" without consultation); all decisions must go through the spec workflow first.
- User asked to keep planning "simple" — lengthy "Open Point" ceremony with numbered decisions/rationale is overhead the user will cut. Prefer terse decision-only docs.
- Background async tasks (monitoring scripts) completed but findings were never explicitly reported — user had to ask twice. Report findings when task completes, don't defer to "next turn".
- User had to repeatedly demand actual proof/evidence rather than accepting assumptions ("j'ai toujours pas vu de preuve la dessus", "tu skips l'output, retourne trop vite?"). Agent cycles through hypotheses (rsync deletes it, PTY allocation causes loss, verbosity flag matters) without systematically isolating variables first.
- User corrected "you managed it all session before, why not now?" — indicates assistant lost context of prior success pattern and didn't connect current failure to what worked earlier.
- Polling CI with manual `sleep` loops (12s, 15s, 30s waits) instead of delegating to `queue wait ci` with `run_in_background: true` — bloats session logs and misses the skill guidance from CLAUDE.md.
- Multiple browser interaction retries with increasing sleep durations (10s→20s→30s→45s) — suggests timing-sensitive frontend deployment; verification window requires adjustment for flaky interactions.
- Multiple sleep-based CI polling (sleep 35, sleep 25) instead of event-driven blocking; predates or doesn't integrate with existing `queue wait ci` command

<!-- session ebbc5644 2026-10-17 -->
- CI waiting strategy evolved during session: naive sleep loops (sleep 100s) replaced by event-driven `queue wait ci` with diagnostics — initial approach burned time waiting blind

<!-- session def50d20 2026-10-17 -->
- Assistant's findings output was truncated/incomplete in the initial transcript chunk — format spec was in instructions but output was cut off mid-response, suggesting context or streaming issue when summarizing session analysis.

<!-- session 3ade944d 2026-10-14 -->
- CI waits consumed 23 minutes of session time via long sleep loops (45-60s intervals between 19:01, 19:43, 20:04-05) while polling for workflow completion — no active monitoring despite poll-ci skill being invoked.
- User discovered token logging issue in RelayConnection error handling (20:58:24 grep search), then updated threat-model.md (21:00:51) — security findings not caught by initial code review

<!-- session adc6a0d7 2026-10-14 -->
- User had to explicitly tell agents not to commit certain files, suggesting over-eager staging and lack of visibility into hold status.

<!-- session c1d3d375 2026-10-14 -->
- Command naming required user redirect: agent wrote relayWebhookList/History; user corrected to "relay webhook list|history" — suggests agent missed naming convention or feature intent.

<!-- session 08232271 2026-10-14 -->
- User corrected command naming mid-implementation: "Rename commands: relay webhook list|history" — API contracts should be finalized before agent begins writing code.

<!-- session 8e9c2749 2026-10-14 -->
- User validated agent outputs with explicit diffs, tsc type checks, and build verification even when tests passed — agent completion != verification complete.

<!-- session bf5f59b2 2026-10-14 -->
- Integration tests need aggressive process/port cleanup on Windows; multiple sleeps (45–60s) inserted to wait for CI or port release; port conflicts recurred (47910/47911/47912) — suggests missing test harness cleanup or port reservation strategy

<!-- session c7e64025 2026-10-14 -->
- User validates each step: builds, type-checking, tests pass before moving forward; no silent fallbacks accepted

<!-- session 634dc215 2026-10-12 -->
- User had to correct output format compliance mid-session — assistant provided truncated/malformed findings despite explicit format spec shown.

<!-- session ddaa4cf0 2026-10-11 -->
- Project structure uncertainty caused rework: views→dsl-frontend, implicit api-backend, then explicit folder split; suggests upfront alignment doc needed before architectural decisions.
- Parallel agents running on different projects (d9e5ed4e on poc-node, c67aed0e on queue) required separate tool schema loading but shared session context — risk of tool failure cascading across parallel work streams

<!-- session 8ae2c774 2026-10-11 -->
- CLI distribution model and SDK readiness timeline should have been negotiated upfront via SendMessage to app-core-owner before implementation started; multiple late-session coordination messages indicate premature starts on assumed contracts.
- Dependency pinning strategy changed from exact versions to latest/* across @wadeck-app packages — this pattern shift not yet documented
- Heavy use of `sleep` (60-90s windows) for CI polling — available `poll-ci` skill not used despite being listed in available skills
- Extensive sleep-based polling for CI completion (100+ cumulative seconds of `sleep 10/15/20/30/60/100`) contradicts CLAUDE.md guidance: use check commands (`gh run view`, `netstat`) rather than sleep loops; multiple edits to deploy-infomaniak.yml suggest workflow requirements needed clarification upfront.
- Heavy use of blind sleep commands (15s, 90s, 100s, etc.) to wait for CI workflows instead of active polling — blocks agent and wastes context. Should use poll-ci skill or loop with backoff.

<!-- session 50367f0a 2026-10-11 -->
- Multiple restructurings (views/ → dsl-frontend/, ModuleContext cleanup) happened mid-session; indicate unclear/evolving requirements. Clarify module layout contract before implementation.
- Dependency versioning corrected mid-session: exact version pins changed to `latest/*` after SendMessage clarified user intent — previous code had wrong assumption about versioning strategy.
- Two agents ran in parallel (d9e5ed4e on poc-node, c67aed0e on queue) with independent sleeps/waits — could have benefited from coordinated tool prefetching to reduce redundant "NOT YET KNOWN" errors across both sessions.

<!-- session c67aed0e 2026-10-10 -->
- User demands autonomous problem-fixing: "pourquoi tu le fais pas ? AUTONOMIE", "bien sur tu corriges bordel... AUTONOMIE" — expects code review findings applied immediately without requesting approval first.
- User questioned `npx app-core-sdk` approach — prefers global CLI binaries for convenience, not per-package installations; suggests workspace should standardize on global `@wadeck-app/app-core-cli` if available.
- Agent performed parallel speculative investigations (git logs, blame, repo searches) without waiting for explicit user scope/direction, increasing context churn before narrowing.

<!-- session f76d9b35 2026-10-11 -->
- Dependency versioning policy for `@wadeck-app/*` packages (pin vs. latest) triggered three separate `SendMessage` calls to different owners (app-core-owner, dsl-owner, cap-owner) — indicates missing or scattered versioning guidance; likely warrants centralized policy doc.

<!-- session a6f2e7c7 2026-10-11 -->
- Manual CI polling with hardcoded sleeps (12–30s between retries) instead of a structured wait-for-CI pattern. Inefficient and fragile approach to checking GitHub workflow status.
- compute-version.sh was silently discarding the breaking-input flag instead of failing loudly; violates CLAUDE.md "fail loudly" principle. Now fixed, but pattern suggests other scripts may have similar silent fallback issues.
- Extensive manual sleep/retry polling (15+ occurrences of `sleep 60/90/120s` + reload loops) for CI status; verification window had to be widened twice (12:52:00, others) due to timeout issues, indicating deployment verification is fragile

<!-- session 91f1ee99 2026-10-11 -->
- Explore agent exploration ran in parallel but findings were applied sequentially; ComponentRegistry/DslRenderer/generated-node-schemas file reads could have been batched after agent returned instead of re-reading parts during implementation.

<!-- session 62eaddc2 2026-10-11 -->
- Skill calls (write-doc at 08:42:30) marked "NOT YET KNOWN" before being fetched — deferred tool/skill names appear in system reminders but require explicit ToolSearch or Skill invocation to load their schemas.

<!-- session c240569c 2026-10-11 -->
- Multi-step SendMessage coordination with app-core-owner to sync timing decisions (SDK availability, folder rename sequence) prevented race conditions but required manual choreography — tight coupling between queue and app-core projects may benefit from versioned contracts or async coordination patterns.

<!-- session 580bfde8 2026-10-11 -->
- Restructured module layout mid-implementation after confirming with app-core-owner; suggests integration requirements underspecified upfront. Future app-core plugin tasks should document or link integration spec before writing structure.

<!-- session 3126a802 2026-10-10 -->
- User corrected assistant on CLI structure: `queue history` (domain audit trail) should be top-level, not `queue cli history` (which groups CLI tooling like version/self-check). Verify domain vs. CLI-tooling distinction when designing commands.
- Synchronous user presence gates in approval workflows block agent flow; agent had sufficient context but required explicit "continue" after 22+ minute idle.

<!-- session 8a40edb8 2026-10-11 -->
- Cross-project coordination required heavy SendMessage back-and-forth to app-core-owner for structure decisions (manifest paths, backend entry points, SDK availability)—suggests upfront contract doc would reduce round-trips.

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

<!-- session fc140a04 2026-10-25 -->
- Multiple successive .mjs scripts written and executed for piecemeal file modifications (sed/edit operations) without upfront scope planning; suggests exploration in place of comprehensive analysis before starting implementation.

<!-- session 53a72f6b 2026-10-25 -->
- Assistant planned for a "migrate-names command" that doesn't exist in the codebase; discovered and corrected at 2026-10-25 10:33:06
- Multiple edits to ciWaitCommand.ts and wait.md docs (16:50-16:52) to clarify relay/repository diagnostics — existing guidance on when exit 3 occurs and what "no delivery" means was ambiguous and needed clarification during implementation.

<!-- session 4ff1a10a 2026-10-24 -->
- Multiple agents (ac5f, acbf, aa20, ae09) spawned in parallel for wall-clock-fragility deflaking across 4+ packages at 09:46:02+ without explicit verification before reporting completion—no evidence results were reviewed for correctness.
- Violations rule `queue-sdk/no-off-outside-tests` created but not auto-applied by global CLI; required manual sample-file testing at 08:08:06-08:08:35 to verify, revealing integration/adoption gap.
- Multiple agents independently discovered timing/flakiness issues in tests and applied logical clocks (`logicalClock.ts`) as a fix pattern, suggesting the issue wasn't diagnosed upfront before running parallel agents on timing-sensitive code.
- Three parallel agents (a7d4, ad8e, a561) were delegated to build independent pieces of the event-catalog feature (SDK, CLI, Dashboard). While the pattern is efficient, the agents made invasive changes across shared files (fakeDaemon.ts, multiple test files) without explicit coordination — conflicting edits were possible.
- write-doc skill invoked before ToolSearch loaded its schema (10:20:54 warning "NOT YET KNOWN"). Agents should validate skill availability or use ToolSearch("select:write-doc") before calling.
- Multiple agents (a561, a7d4, ad8e, ac5f, ae09, acbf) editing interdependent files simultaneously required manual SendMessage coordination to prevent race conditions. The coordination was explicit but fragile.

<!-- session ca620a5a 2026-10-24 -->
- Hardcoded version strings ('1.0.0' → '1.1.0') updated in multiple test files instead of using PROTOCOL_VERSION constant — suggests agents don't enforce DRY or know about existing constants.
- Multiple temporary fixture .mjs files created in /tmp (ed3.mjs through ed8.mjs) without visible cleanup — test infrastructure complexity is leaking resource management responsibility.
- Skill invocation (write-doc at 10:20:54) attempted without first using ToolSearch to load its schema — skill name was "NOT YET KNOWN"
- Frequent creation of temporary .mjs transformation scripts in /tmp/qfixture (add-links.mjs, abandon-op.mjs, stuck-op.mjs, events-ui-tests.mjs, etc.) to generate test and implementation code across multiple files, rather than using systematic file edits. Pattern works but suggests agents were treating complex cross-file refactoring as scripting problems instead of coordinated edits.

<!-- session 29f6efb2 2026-10-24 -->
- Agents spawned for parallel deflaking (queue-cli, queue-relay-client, core/sdk/plugin) at 09:45-09:46 created shared test helpers (waitFor.ts) within each delegation scope rather than upfront — should have provided common test utilities before spawning so agents could focus on applying them.
- Multiple agents write temp fixture files with no cleanup strategy; later manual intervention needed (queue-replay-cwd-* directory cleanup with Windows attrib issues)
- File coordination between parallel agents on waitFor.ts is reactive (SendMessage after conflicts) not pre-planned; ae09 and aa20 both modifying the same file without explicit division
- None detected in command syntax or assumptions.

<!-- session 93cf3ce8 2026-10-18 -->
- Invoked deferred MCP tools without using ToolSearch to load schemas first (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs)
- Repeated user clarifications on dependency structure and module scope at 13:14, 14:14, 14:47 — insufficient pre-implementation requirements analysis; same ambiguity prompted user three times rather than resolving once
- manifest.json was missing `"id": "queue"` field, causing app-core module registration to fail.
- Multiple test file import fixes required (fileURLToPath, index.ts exports, RelayDaemon.ts exports) — initial scaffolding was incomplete.
- Manual 110-second sleep used instead of documented `queue wait ci <sha> --cli-foreground` command from CLAUDE.md (line about waiting for CI after push)
- Manual polling loop (`for i in $(seq 1 30)`) for relay status instead of proper waiting mechanism, despite `queue wait ci` pattern being documented

<!-- session 0b8f766f 2026-10-18 -->
- Assistant asked clarification questions mid-refactoring (13:14:14, 14:14:46, 14:47:49 in French: queue-cli deps, business logic scope, module capabilities) rather than up front. Large architectural refactoring (file moves, package restructuring) proceeded without confirming design decisions first — clarifications came during implementation.
- Directory structure assumptions: files were initially in `src/`, then discovered they needed to be in `src/backend/` and `src/dsl-views/` per app-core requirements, requiring a bulk move and path rewrites.

<!-- session 1f6af8e0 2026-10-18 -->
- MCP tools called without loading schemas first via ToolSearch (fragment shows mcp__github-wadeck-app__actions_list, etc. marked "*** NOT YET KNOWN ***")
- Multiple AskUserQuestion entries in French ("Quel chemin...", "Le module doit...") contradict stated English-default requirement
- manifest reorganization and module setup took multiple iterations; assistant was discovering structure requirements during implementation rather than validating upfront
- Permission bypass flow via `request-bypass.js` requires explicit approval; agent correctly used this but path is non-obvious for future sessions

<!-- session de7e2366 2026-10-18 -->
- Large refactoring executed without upfront strategy — 30+ sequential small edits (file moves, imports, test writes) across multiple packages without explaining the end state first; required mid-stream user clarifications (AskUserQuestion at 13:14, 14:14, 14:47) and coordination emails to other teams.
- Underestimated migration scope mid-task: moving app-module-queue to app-core-cli layout required not just src/ restructuring but parallel updates to manifest.json ("id" field requirement, not initially caught), tsconfig.json, .gitignore, package.json, and bundle script rewrites. Discovered incrementally through app-core validation failures.
- Used temporary .mjs shell scripts to transform complex file structures (manifest rewriting, import path swaps, bundle edits) instead of direct file operations, suggesting the transformation patterns are not well-understood or are too multi-line for simple Edit tool usage.

<!-- session e3a1928e 2026-10-18 -->
- At 12:43:59, agent entered sleep loop (100s + 60s waits) instead of using `queue wait ci` notification; polling wastes cache and token context. Should use the `poll-ci` skill exclusively after pushes.
- At 13:09:39, discovered mid-implementation that `configDir` logic should move from app-module-queue to queue-core but continued implementing instead of pausing to confirm scope with user first.
- At 14:14:18 and 14:47:25, `AskUserQuestion` calls marked "NOT YET KNOWN" — user question mechanism failed silently; agent inferred decisions instead of confirming.

<!-- session ebf8428c 2026-10-18 -->
- 40-minute investigation of daemon/update/registration mechanics (11:56-12:51) before recognizing CLI vs daemon boundary — reverse-engineered from shared-updater and app-core dist/ instead of asking

<!-- session 9d143482 2026-10-18 -->
- File created in wrong location—both `.claude/lessons-learned.md` and `.claude/kb/lessons-learned.md` committed, but CLAUDE.md specifies lessons should be at `.claude/kb/lessons-learned.md`; suggests kb skill or file creation logic sent it to wrong directory initially

<!-- session 4047e640 2026-10-18 -->
- When invoking deferred tools (write-doc, code-review, poll-ci, etc.), agent must preemptively fetch schemas via ToolSearch before calling them directly — calling without fetching will fail with InputValidationError

<!-- session 6b2405c4 2026-10-18 -->
- R9 agent diverged on backoff/subscription logic; user redirect with "finish from the red state, narrow scope" mid-task — complex async patterns need explicit upfront constraints before implementation

<!-- session 19baf9ca 2026-10-17 -->
- Deferred MCP tools (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__actions_get, etc.) were invoked directly without first calling ToolSearch to fetch their schemas; resulted in "NOT YET KNOWN" warnings at 09:21:53, 09:24:01, 10:41:56, and elsewhere.
- Skills (write-doc, poll-ci) referenced without pre-loading: should call ToolSearch to fetch deferred skill definitions before invoking (occurred at 17:25:16, 18:05:48).
- Trial-and-error code edits (HistoryFollower.ts, history.test.ts, history-page.yaml) without root-cause diagnosis — multiple edit-run-edit cycles suggest guessing rather than targeted fixes (09:46:29 through 09:49:10).
- Imports wired using sed shell commands (17:24:04, 17:37:20) rather than Edit tool — hard to review and error-prone compared to structured edits.

<!-- session ce5be425 2026-10-17 -->
- Three research agents spawned in parallel (Explore, general-purpose, claude-code-guide at 09:49:12) for CI polling/GitHub Actions/Claude Code wake mechanisms — ran extensive WebFetch chains but no verification that findings were consumed or integrated into implementation.
- Feature files (ciWait.ts, waitCli.ts, ciInfer.ts) written before tests were integrated into test files; mixed implementation-first then test-after order instead of strict test-first discipline flagged in earlier chunk feedback.

<!-- session 75764a93 2026-10-17 -->
- Spawning agents without pre-fetching tool schemas: SendMessage/ListAgents and mcp__github-wadeck-app__* tools marked *** NOT YET KNOWN *** caused delays (09:00:44, 09:21:53 onwards). Always use ToolSearch to preload before invoking agents that depend on MCP tools.
- General-purpose agent performed 30+ WebFetch calls researching CI completion patterns (09:49:22–09:50:13) when the queue project's own CLAUDE.md already documented the `poll-ci` skill solution. Agents should search project docs before external research.

<!-- session 179c5926 2026-10-17 -->
- GitHub MCP tool schemas not pre-fetched before use — multiple "NOT YET KNOWN" warnings for `mcp__github-wadeck-app__actions_list`, `actions_get`, `get_job_logs` indicate tools were invoked without `ToolSearch` loading their schemas first.
- write-doc skill bypassed — at 17:25:16 when write-doc skill showed as unknown, assistant read/edited README.md directly instead of using `ToolSearch` to load the skill first or invoking the skill workflow.

<!-- session ac4c2b8f 2026-10-17 -->
- Assistant assumed GitHub MCP tools could re-run CI jobs; corrected with "I could not re-run the CI job" (09:56:34→09:56:40).

<!-- session b342b025 2026-10-17 -->
- General-purpose agent performs extensive external web research (GitHub Actions, merge queues, Temporal signals, Argo Events, bors-ng, Zuul, Prow) on CI completion patterns, suggesting project-specific CI integration strategy is not documented internally.

<!-- session 5ea726b4 2026-10-14 -->
- Agents reporting "tests pass" without showing evidence allowed vacuous tests through twice (R4, then relayed as fact by reviewers). P2b reviewer ignored explicit instructions not to delete files.
- Test suite reported pass in 144–263 ms when it required 3+ seconds; agent's own description acknowledged early return, suggesting silent test failure.
- R9 agent left RelayConnection.ts partially modified when interrupted; state had to be manually repaired before use.
- W1 excluded test files from tsconfig.json type checking, breaking CI verification; excluded test files still contained errors.
- R10 implemented wrong test case: created healthy-reconnection test instead of dead-peer detection as requested.
- Test files included in TypeScript build output; tsconfig.json must exclude test files with `"exclude": ["**/*.test.ts"]` to prevent compilation errors in dist/.
- Type annotations missing in catch blocks: `catch (e)` → `catch (e: any)` required for TypeScript strict mode in test files.
- VBScript cleanup not automatic; must explicitly count temp files before/after tests to verify no leaks (e.g., `ls $TEMP/queue-spawn-*.vbs | wc -l`).
- During follow mode implementation, tests with `--follow` flag timeout indefinitely; adjust test strategy to verify the error check (offset + follow) without actually invoking follow mode.
- When seeding test history files in integration tests, previous test runs leave stale entries in the history directory, polluting test assertions; either isolate test directories or verify exact counts rather than string matches.
- setInterval tests assumed intervals fire immediately; they only fire after the specified delay—simplifying rather than fixing timing is a pattern
- When reviewing queue-cli changes, dead code was discovered: `/src/relay/resolveRelayDaemonScript.ts` and its test were never imported or used — the logic was duplicated inline in `QueueIndex.ts` at line 521. The file existed but was unreachable.
- Type imports in new relay-related code were incomplete — `RelayCommands`, `RelayConnectionError`, and other types from `queue-relay-client` were used without imports, caught by `tsc --noEmit`.
- Test coverage for new optional parameters (`extraEnv` in `spawnDaemon.ts`) was not added initially — discovered during review, requiring a retroactive test case to be written.
- WebSocket heartbeat tests discovered that ws library auto-responds to pings with pongs, so simulating a "dead server" requires explicitly terminating the connection, not just silencing it. Initial implementation assumed a non-responsive server would not respond to heartbeat pings.
- TypeScript type error in new RelayDaemon.test.ts used invalid ShutdownReason value 'test' instead of valid union members ('idle'|'signal'|'command'|'error'|'update'). Found during type-check, not at review time — suggests the test was not validated before implementation.
- Test isolation failed with module-level `inFlightStarts` map — shared state across tests masked the concurrency bug being fixed; had to refactor tests to realize this demonstrated the actual bug.
- Mock setup required specific return types: `stderr.write()` returns boolean, not void — TypeScript errors caught this but setup complexity led to trial-and-error iterations.
- Test verification incomplete: message text not checked in first iteration, allowing false positives where rotation failures incorrectly said "NOT being persisted" instead of "file will keep growing". Caught only by secondary review.
- Silent error handling bug: when rotation fails with non-ENOENT error, code rethrows, skipping the `appendFileSync` — tests passed because they didn't check that all lines were written. Behavioral correctness invisible to test assertions.
- Race condition in connectLoop's sleep loop wasn't caught by initial tests—tests missed verifying stop() interrupts mid-delay. Added checks after sleep in fix phase, not test phase.
- Dead code path in connectLoop error handler wasn't removed initially. Tests didn't enforce that error cases use the correct handler. Reviewer catch.
- Test regex for VBScript output required multiple iterations. Could have examined the actual code generation (`buildLaunchScript`) first instead of iterating on the regex pattern.
- Test vacuity: initial test claimed to test crash path but never triggered it; must verify the failure case is actually reachable and does fail when the guard is removed.
- Daemon shutdown incomplete: initial error-path implementation called `daemonHandle.stop()` but forgot to call `connection.stop()` first—exit path must stop all resources before exiting, not just some.
- Listener leak in async sleep pattern: `addEventListener('abort', ...)` was never removed, persisting across loop iterations and accumulating listeners on each retry.
- Dead code: `resolveReplayCwd` was implemented in app-module-queue when it should only exist in queue-cli. Created 4 unused unit tests there before coordinator feedback.
- T1 initial implementation treated PASSTHROUGH_FLAGS as special (returning 'inherit' instead of 'ignore'), but spec was: they stay unused at the template call site. Reverted in second pass.
- T1 notice logic was missing the condition "AND stdin was auto-detected" — initial code printed notice whenever TTY was true, not just when auto-detection happened.
- D6b integration test lacked guards to assert cwd values are actually different (A ≠ B) before testing the mismatch error. Added after feedback.
- Assistant claimed R4 tests were added to RelayConnection.test.ts when they weren't actually in the file — silent test failure counted as implementation success until coordinator independently verified the file contents.
- E2e test initially checked stderr for relay messages, should have been stdout — forced full debugging session that revealed the actual output stream.
- E2e test's process-exit assertion silently didn't run because relayDaemonPid remained null, making the test pass when it should have caught bugs; silent skip-like condition was never surfaced.
- MCP tools registered as "NOT YET KNOWN" in command log despite being available — ToolSearch calls show warnings but commands still run; suggests tool schema preloading delays rather than failures, but creates noise in logs.
- Agent assumed app-core was running on port :4852 but the correct instance was :4850 (installed package); verified only after failed POST attempt. Should verify port→instance mapping before requests.
- ToolSearch failed to load deferred tool mcp__github-wadeck-app__issue_write, blocking GitHub operations.
- General-purpose agent delegated for R10 (websocket liveness) required multiple test cycles and edits (21:50-21:58); suggests ping/pong + relay-restart interaction is fragile/tricky.

<!-- session f8709619 2026-10-17 -->
- Used sleep-based polling loops (`sleep 100; echo ok`, `sleep 110`) for CI waiting instead of applying the event-driven patterns researched from Temporal, Prow, Tide, Zuul, Mergify, and other systems — research scope mismatch with actual implementation.
- Launched general-purpose agent to research CI completion across 12+ systems (Temporal, Prow, Tide, bors-ng, Zuul, Mergify, Cursor, OpenHands, Devin, Copilot, Inngest, Argo Events) when the task was GitHub Actions specific — excessive breadth without narrowing.
- Attempted to call MCP tools (mcp__github-wadeck-app__actions_list, actions_get, get_job_logs) marked "NOT YET KNOWN" multiple times, causing retries — should have loaded schemas upfront with ToolSearch.
- Called Skill for `poll-ci` and `write-doc` repeatedly before those skills were loaded — these should have been ToolSearch'd or resolved before use.

<!-- session 3c886490 2026-10-17 -->
- Deferred tools (mcp__github-wadeck-app__*, Skills like poll-ci/write-doc) used without first loading schemas via ToolSearch — causes repeated "NOT YET KNOWN" warnings. Pattern: always check system-reminder deferred list and call ToolSearch("select:tool-name") before invoking.
- Multiple parallel agents spawned for independent research (Explore, general-purpose, claude-code-guide) with heavy WebFetch operations; main agent visibility into outputs unclear. Pattern: document expected output before spawning parallel agents; consider sequential stages if outputs must feed next steps.

<!-- session a8b0f71b 2026-10-17 -->
- Agents delegating CLI code generation with test files don't ensure test files are excluded from tsconfig.json build—user had to manually add excludes afterward.
- Multiple deferred tools marked "*** NOT YET KNOWN ***" (SendMessage, mcp__github-wadeck-app__* methods, skills write-doc/poll-ci) require ToolSearch before use, creating unnecessary round-trips; should be pre-loaded or cached.
- Research agent (general-purpose) performed broad industry research on CI systems (GitHub Actions, Mergify, Tide, Bors, Zuul, Temporal, Argo) instead of narrowly targeting the GitHub Actions workflow_run webhook payload schema—suggests question was underspecified or agent search was inefficiently broad.

<!-- session 7e05adc0 2026-10-17 -->
- Deferred tool schemas invoked without preemptive ToolSearch: mcp__github-wadeck-app__* tools and write-doc/poll-ci skills reported "NOT YET KNOWN" on first use (09:21:53–09:44:12, 18:04:30–18:05:52), causing retry cycles instead of loading schemas upfront via ToolSearch
- Parallel agent spawning for open-ended research (Explore, general-purpose, claude-code-guide at 09:49:12) created massive WebFetch output; coordinator then manually verified findings with bash instead of requesting agents confirm results, defeating delegation

<!-- session 69a576ad 2026-10-17 -->
- Tested queue wait ci against local repo builds and screenshots of isolated instances, then claimed "confirmed live, end-to-end" — real validation only happened later against the published package installed globally
- Spawned three research agents in parallel (Explore, general-purpose, claude-code-guide) early to study CI mechanisms and wake-up patterns — consumed context without delivering integrated findings; later work was independent of their outputs

<!-- session 7de46642 2026-10-17 -->
- Multiple attempts to use unloaded MCP tools without ToolSearch first (github-wadeck-app actions_*, get_job_logs at 09:21:53–09:24:12; write-doc skill at 17:25:16) — always ToolSearch before unfamiliar tools/skills

<!-- session d9e5ed4e 2026-10-11 -->
- Assumed process name mismatch was root cause of CI failure without first verifying the actual deployed process name. Took multiple rounds to discover `npm start` was launching the wrong binary entirely.
- Misidentified "maintenance page" as a separate toggle malfunction when actual issue was Infomaniak's edge proxy health-check, independent of app status.
- I introduced an untested variable (simple-server.js without PM2) while isolating the problem, which obscured rather than clarified the root cause; user had to realize I'd changed two things at once.
- CI script had a bug where the deployment verification checked the SSH hostname instead of the public domain, causing false failures.
- I tested the auth token flow myself and never shared the generated token with the user, leaving them unable to verify the fix worked.
- I declared the auth implementation "complete" without auditing all endpoints; had to go back and verify WebSockets and static paths were actually blocked.
- Assumed environment variables could be set on Infomaniak platform; user corrected that custom env vars aren't exposed. Always verify platform constraints before proposing secrets/config implementations.
- Claimed SSH connectivity works in CI based on one successful `pkill` call; later diagnostics revealed systematic exit-255 failures on other SSH commands. Need explicit verification that *all* SSH calls succeed, not inference from a single one.
- w-guardrails hook (`checkKillSwitchWrite` undefined) crashed Edit tool; when a tool fails via plugin hook bug, don't retry — signal user and ask them to check plugin config.
- Verified code components locally but didn't test full happy path; WebSocket upgrade failed silently because front-door auth gates `/relay-ws`. Always trace end-to-end flow, not just components.
- Security model designed before clarifying with user (hashing/storing secrets); agent then went down unnecessary rabbit holes (hashing, `cat` exit codes, bash `-e` + `$(...)` bugs, applying `${var:-default}` incorrectly causing empty args to re-default). Multiple failed assumption cycles: rsync hypothesis, PTY allocation, verbosity flags — all disproven but time-consuming to isolate.
- Agent misread log output early ("ça, c'est le log de l'app ... ce n'est pas le retour de la commande SSH") and didn't realize SSH exec stdout was systematically suppressed until user asked to "regarde sur le net" (look it up). The actual fix (use `scp` instead of ssh exec) required a protocol switch, not a flag tweak.
- `list_workflow_runs` tool repeatedly returned full history despite `per_page` parameter being set; agent only realized mid-session and switched to `list_workflow_jobs` to save context.
- Repeated failing bypass requests instead of systematically debugging (reading bypass state file, checking hook config). Made speculative theories (session pinned to project, grant in wrong dir, hook categorization) without evidence.
- Over-delegated to poc-node-owner instead of solving directly; user had to explicitly redirect with frustration ("t'es en charge !!!").
- Parallel Explore agent + main session competing for npm install locks during workspace registration (08:47, 09:05) causes slowdowns; sequencing workspace ops would be more reliable.
- Multiple agents invoked MCP `actions_list` and `actions_get` methods returning "NOT YET KNOWN" — suggests incomplete schema or method name mismatches in GitHub MCP tool definitions.
- Agents assumed exact version pins were correct in package.json; user had to correct to track `latest` — indicates missing project-level documentation on dependency pinning strategy.
- MCP tools (mcp__github-wadeck__actions_list, actions_run_trigger, get_job_logs) repeatedly marked "NOT YET KNOWN" — schemas not loaded before use; should use ToolSearch before first tool call in new session.
- Skill calls (kb, agent-browser) invoked without ToolSearch upfront — produced "NOT YET KNOWN" warnings; deferred tools must be fetched before invocation.
- ExitPlanMode called at 14:45:07 without schema fetch; ToolSearch called later at 14:50:42 — tool invocation preceded availability check.
- Multiple GitHub MCP tools (mcp__github-wadeck__actions_list, mcp__github-wadeck__get_job_logs) showed "NOT YET KNOWN" at 15:19+, indicating schema fetch did not precede use.
- When MCP GitHub tools report "NOT YET KNOWN", agent must fetch schema via ToolSearch before retrying or falling back to alternatives; currently agent silently retries the same failing call or abandons it.
- After git push with CI outcome dependency, agent reverts to `sleep` polling loops instead of using `queue wait ci` with `run_in_background: true` (documented in CLAUDE.md); this chunk has ~200 seconds of sleep waiting for CI across both agents.
- When job log retrieval fails repeatedly (MCP get_job_logs unavailable), agent escalates to web search (DuckDuckGo) for private deployment diagnostics, which is inappropriate; should recognize root cause (tool unavailability) instead.
- Agent performs increasingly complex Grep pattern matching (lines 18:04:43–18:24:35) on unavailable logs without recognizing root cause is failed MCP tool calls, not malformed log content; symptom of not debugging the real blocker.
- GitHub Actions tools (mcp__github-wadeck__actions_list, mcp__github-wadeck__get_job_logs) repeatedly returned "*** NOT YET KNOWN ***" warnings — schema registration or parameter passing issue preventing CI log retrieval

<!-- session ebbc5644 2026-10-17 -->
- MCP tools repeatedly invoked before schema loading: actions_list/actions_run_trigger/get_job_logs threw "NOT YET KNOWN" errors — should proactively use ToolSearch before first MCP tool call

<!-- session 6392f3bd 2026-10-17 -->
- Repeated calls to deferred MCP tools without first fetching schemas via ToolSearch: mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__actions_get, mcp__github-wadeck-app__get_job_logs all returned "NOT YET KNOWN" warnings. Fetch schemas upfront with `ToolSearch({query: "select:<name>"})` before invoking.
- Skills marked as "NOT YET KNOWN" at invocation (write-doc, poll-ci). Skills should be loaded via ToolSearch before use if schemas are deferred.

<!-- session 13321a8b 2026-10-17 -->
- Repeatedly called deferred tools (mcp__github-wadeck-app__actions_list, actions_get, get_job_logs) without fetching schemas via ToolSearch first, causing "NOT YET KNOWN" errors across multiple attempts (09:21:53, 09:43:59, 09:44:03, 09:56:12, 09:59:46, 10:41:39). Must use ToolSearch(query="select:<tool_name>") BEFORE calling deferred tools, not after.
- write-doc skill invocation failed "NOT YET KNOWN" (17:25:16) — deferred skills may require ToolSearch before Skill() call.
- At 09:56:34 attempted CI job re-run, then corrected (09:56:40) that re-run capability doesn't exist — verify operation feasibility before attempting, not after error.

<!-- session 3c7a133b 2026-10-17 -->
- ToolSearch returned "NOT YET KNOWN" querying `select:SendMessage,ListAgents` — tools were in deferred list but fetch appeared to fail; SendMessage was successfully called anyway, suggesting cache or automatic resolution masks fetch failures

<!-- session 55ec4363 2026-10-17 -->
- ToolSearch returned "NOT YET KNOWN" for deferred tool schema load (select:SendMessage,ListAgents) but assistant proceeded to call those tools anyway; need explicit guard when schema load fails

<!-- session ae4adeff 2026-10-17 -->
- Called `mcp__github-wadeck__actions_list` and `mcp__github-wadeck__get_job_logs` multiple times without fetching their schemas via ToolSearch first. These are deferred tools — must call `ToolSearch(query: "select:mcp__github-wadeck__actions_list,...")` before invoking.

<!-- session bd9a10de 2026-10-17 -->
- ToolSearch query for deferred tools (SendMessage, ListAgents) returned "NOT YET KNOWN" — the agent should have called ToolSearch to load schemas before using these tools, or these tools may not have been properly registered in the deferred list at the time.

<!-- session 66130988 2026-10-17 -->
- ToolSearch returned "NOT YET KNOWN" for SendMessage and ListAgents (line: "query=select:SendMessage,ListAgents | max_results=2"), but both tools were invoked successfully moments later — suggests either spurious "unknown" warning from ToolSearch, or deferred tools briefly unavailable then resolved. Pattern: fetch deferred tools before using them, even if ToolSearch warns.

<!-- session dadc38c4 2026-10-17 -->
- GitHub Actions MCP tools (mcp__github-wadeck-app__actions_list) failed to load during CI polling, blocking automated status checks—required manual sleep/retry loops instead.

<!-- session 193146ba 2026-10-17 -->
- Using MCP tools (mcp__github-wadeck-app__actions_list, get_job_logs) without calling ToolSearch first to load schemas; marked "NOT YET KNOWN" repeatedly. Deferred tools must be loaded before use: call `ToolSearch("select:tool_name")` before invoking.
- Monitoring CI completion with manual sleep loops (60s, 55s intervals) instead of the `poll-ci` skill, which actively monitors and returns the final status.

<!-- session 12f0593c 2026-10-14 -->
- Deferred tools marked "NOT YET KNOWN" (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs, poll-ci skill) were retried 10+ times before fallback; agent should recognize "still connecting" state from system-reminder and either wait once or switch to alternatives immediately rather than spin.
- Agent implementing R9 task entered failure state mid-implementation; user redirected with "finish from the red state, narrow scope" rather than agent completing independently.
- Agent created W1 CLI commands (relay webhook list/history) but naming required user correction ("Rename commands: relay webhook list|history" at 21:26:23).

<!-- session 3ade944d 2026-10-14 -->
- Deferred MCP tools (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs) invoked without ToolSearch preload; system warned NOT YET KNOWN at 19:00-19:01, yet invocations continued — occurred again at 19:43-19:44 after git push. Skill `poll-ci` also invoked without checking availability first.
- Agent created CLI webhook commands but user redirected naming: sent "Rename commands: relay webhook list|history" mid-task (21:26:23), suggesting the agent's initial command names didn't match requirements
- Agent's relayRead.integration.test.ts had multiple replace_all edits needed (21:30:48-21:31:06); structure required post-generation fixes from user

<!-- session adc6a0d7 2026-10-14 -->
- Agents (ade2, ab50) spawned for substantive refactoring made multiple successive edits to the same files without verification of completion.
- Agent a03e created new CLI command files but didn't verify tsconfig configuration; user had to manually exclude test files from build output (21:31:39)
- Agent a03e's relayWebhookList.test.ts needed user fixes post-creation (21:36:10); test completeness wasn't validated before handoff
- general-purpose agent made 8+ sequential edits to RelayConnection.ts/test.ts files instead of one comprehensive change — suggests incomplete requirements or incomplete understanding of scope upfront; agent should have received fuller context about all ping/pong changes needed at once.

<!-- session c1d3d375 2026-10-14 -->
- Platform-dependent errno assertion: RelayLogger.test.ts hardcoded `ENOENT` but Linux returns `ENOTDIR` for same condition; must use error.code matching instead of exact error type.
- R9 ack-driven backoff test took ~8 min of edit cycles (21:11–21:19) with repeated test runs — logic may be underspecified or agent struggled to thread backoff state + HTTP 429 handling correctly.
- Agent spawned for WebSocket liveness task (R10) made sequential edits to RelayConnection.ts without TDD-first approach — should have extended test suite before implementation to clarify expected behavior

<!-- session 08232271 2026-10-14 -->
- Deferred MCP tools (mcp__github-wadeck-app__actions_list, mcp__github-wadeck-app__get_job_logs) called without loading schemas first via ToolSearch — tool invocation without schema fetch fails.
- User redirected agent a4d8 mid-task with "R9: finish from the red state, narrow scope" — agent had expanded scope beyond the original narrow requirement.
- ToolSearch called at 21:21:57 for mcp__github-wadeck-app__issue_write with warning "*** NOT YET KNOWN ***" — agent attempted tool use before loading its schema.
- Agent made 7 sequential rapid edits to RelayConnection.ts (21:50–21:51) suggesting trial-and-error implementation rather than a clear planned change.

<!-- session 8e9c2749 2026-10-14 -->
- Assistant attempted format correction but output was truncated/malformed in previous turn, showing incomplete line `[Doc` and cut-off summary.
- Agent a4d8 modified RelayConnection.ts error messages (line 258+) but phrasing needed user correction — agent didn't match existing error message conventions.
- Agent a03e generated relayApi/webhook commands with passing tests but tsconfig.json didn't exclude .test.ts files from compilation — user had to add exclude pattern.
- General-purpose agent made 10+ sequential edits to RelayConnection.ts/test.ts without batching or explaining the implementation strategy upfront — when delegating complex code changes, intermediate reporting about the overall plan and scope would prevent context confusion and enable faster main-session validation.

<!-- session bf5f59b2 2026-10-14 -->
- General-purpose agents (ade2, ab50) showed excessive trial-and-error on relay auth/config tests: multiple edit-run-edit cycles on RelayConnection.test.ts and secrets.test.ts without clear incremental progress — suggests incomplete understanding of test contract before implementation
- R9 agent (a4d8) got stuck or diverged on backoff/subscription logic; user mid-session redirected with "finish from the red state, narrow scope" — indicates need for explicit checkpoint markers on complex cross-system features.
- General-purpose agent made 6+ sequential edits to RelayConnection.ts without visible user verification step; per CLAUDE.md policy, agent output must be tested/confirmed before trusting, but logs show no test run or user confirmation of the changes

<!-- session 51a43681 2026-10-14 -->
- Called Skill (poll-ci) and ToolSearch before schemas were loaded — multiple "NOT YET KNOWN" warnings (19:00 block). Should use ToolSearch to load deferred tool schemas BEFORE attempting to call the tools.
- Polled CI manually with hardcoded sleep 45/50/60s instead of invoking poll-ci skill properly after push. Wasteful polling pattern when a skill existed for this.
- Platform-specific test failure (ENOENT vs ENOTDIR on Linux) not caught locally; only surfaced after CI run. Cross-platform errno assertions need platform detection or OS-agnostic codes.
- Agent a03e generated CLI commands with accompanying test files but didn't exclude test files from tsconfig.json build—main user had to manually add excludes afterward. Agents delegating code generation should reference repo's build conventions upfront.

<!-- session c7e64025 2026-10-14 -->
- Tool availability not checked before invocation: attempted `poll-ci` skill and `mcp__github-wadeck-app__*` tools before they were ready (19:00:07–19:00:40), requiring fallback to manual polling
- Output format assumption error: initial findings didn't match user's required `[Section] finding` format; required explicit user correction
- Agent initially named relay commands incorrectly; user corrected to "relay webhook list|history"
- Agent over-scoped R9 task; user narrowed with "finish from the red state, narrow scope"

<!-- session c6b7adc0 2026-10-12 -->
- Barrel index.ts deletion triggered cascading import fixes across replay.test.ts and QueueIndex.integration.test.ts — should have preceded with full import-path audit (grep search) to surface all dependent code before removal.

<!-- session a02c760f 2026-10-12 -->
- Repeated calls to deferred MCP tools (mcp__github-wadeck-app__actions_list) without first fetching schema via ToolSearch, resulting in "NOT YET KNOWN" warnings instead of using ToolSearch to load schemas before invocation.

<!-- session ddaa4cf0 2026-10-11 -->
- SDK type distribution misunderstood upfront — created local moduleContext.ts mirror to bypass missing types instead of inspecting SDK's package.json types field or exports, discovered correct path (index.bundle.d.ts) only after manual digging.
- MCP GitHub action tools fail with "NOT YET KNOWN" schema errors (actions_list, get_job_logs, pull_request_review_write) — blocks CI monitoring workflows.
- poll-ci skill invoked but marked "NOT YET KNOWN" — fallback to manual sleep + grep polling used instead.
- agent-browser invocation confusion — session c67aed0e tried `agent-browser launch`, `agent-browser install`, `--help`, then searched README before finally using `--session queue-check open` successfully; suggests agent didn't know proper initialization or tool was missing from that context
- kb skill not found — called at 12:45:55 with "NOT YET KNOWN", user immediately worked around by manually reading/editing `.claude/kb/lessons-learned.md` files instead; skill may not be wired in current environment
- Multiple attempts to use deferred tools (EnterPlanMode, ExitPlanMode, mcp__github-wadeck__actions_list, AskUserQuestion) without first fetching their schemas via ToolSearch — resulted in "NOT YET KNOWN" warnings and probable cascading failures

<!-- session 8ae2c774 2026-10-11 -->
- Assistant iterated on app-core-sdk imports and backend.test.ts mock/handler fixtures without first understanding the SDK's published type shape (index.bundle.d.ts vs index.d.ts) or the expected req/reply handler contract.
- Repeated calls to `mcp__github-wadeck-app__actions_list` and `mcp__github-wadeck__actions_list` with methods marked "NOT YET KNOWN" (list_workflow_runs, list_workflow_jobs, get_job_logs) — agent kept retrying same method without checking schema first
- Used sleep-based polling (15s/20s/30s/45s/60s/90s waits) instead of real status checks; inefficient for long-running deployments
- general-purpose agent spawned at 14:24:19 to "Investigate poc-node restart loop from log file" but no findings reported back; session continues editing specs without acting on agent's results
- Multiple deferred tools (EnterPlanMode, ExitPlanMode, GitHub Actions MCP tools) initially reported "NOT YET KNOWN" and required ToolSearch to fetch schemas before use; agent adapted by writing plan file directly rather than using plan-mode tools explicitly.
- Global npm install (`npm install -g @wadeck-app/app-core-cli@latest` at 15:21:16) executed without explicit user request, violating CLAUDE.md policy: "NEVER install applications...global npm/pip packages...without explicitly asking the user first."
- ToolSearch itself failed with "NOT YET KNOWN" at 17:26:40 when trying to fetch mcp__github-wadeck__actions_get — suggests circular dependency or improper deferred-tool bootstrapping.

<!-- session 50367f0a 2026-10-11 -->
- Attempted to invoke `write-doc` skill without fetching schema first; should use ToolSearch before Skill calls when tool availability is uncertain.
- Multiple failed MCP tool calls (`mcp__github-wadeck-app__actions_list`) marked "NOT YET KNOWN" — indicate schema fetch was needed upfront.
- Tried `agent-browser` skill without confirming installation/daemon state; spent iterations debugging launch instead of checking prerequisites first.
- Repeated "NOT YET KNOWN" warnings for GitHub MCP tools (`actions_list`, `get_job_logs`) — agent calls them without schemas loaded; ToolSearch may not fully resolve all method variants or they aren't registered at call time.
- Heavy polling loop with manual `sleep` commands (15/20/30/90s) instead of using poll-ci skill or waiting on workflow signals — wastes token context and creates coordination bottleneck between parallel agents.
- Breaking-version flag silently discarded in compute-version script — agent discovered via investigation that `breaking-input` parameter was ignored when `manual_version` was absent, not failing loudly; fix required edit to ci-templates.
- Called `mcp__github-wadeck__actions_list` and `mcp__github-wadeck__get_job_logs` multiple times (12:16, 12:25, 12:27, 12:47, 12:49, 12:50, 12:51, 12:56, 13:03) without fetching their schemas via ToolSearch first—each returned "NOT YET KNOWN" warning instead of failing fast. Pattern shows repeated polling of an unusable tool instead of selecting a fallback or pre-fetching schemas.
- Attempted Skill invocations (`kb` at 12:45:55, `agent-browser` at 12:55:34) without verifying they were available or fetching their schemas in advance.
- Multiple deferred tools called without ToolSearch fetch first: `mcp__github-wadeck__actions_list`, `mcp__github-wadeck__get_job_logs` returned "NOT YET KNOWN" on first attempts, forcing retries. Agent should preemptively fetch critical MCP tools via ToolSearch before polling CI in background.
- EnterPlanMode/ExitPlanMode used without being fetched — resulted in "NOT YET KNOWN" warnings and plan file written anyway, bypassing the intended tool flow.
- MCP tools called without loading schemas first: `mcp__github-wadeck__actions_list`, `mcp__github-wadeck__get_job_logs`, `mcp__github-wadeck-app__actions_list` all marked "NOT YET KNOWN" repeatedly. Deferred tools need ToolSearch() before use.
- ToolSearch itself invoked with "NOT YET KNOWN" status (line 17:26:40), indicating a meta-tool initialization issue.

<!-- session c67aed0e 2026-10-10 -->
- Assistant incorrectly attributed scope limitations to user-provided plan; plan was actually from inter-agent discussion. User corrected: "c'est moi qui t'ai fourni ce plan ? je ne crois pas ;) c'est une discussion entr agent..."
- Assistant misinterpreted `queue-app-module` as out-of-scope based on plan text; user clarified they wanted it implemented in this repo as a separate package, not in a distinct repo.
- Attempted SDK type swap before confirming published `.d.ts` was self-contained — the first version still exported types referencing unpublished `@wadeck-app/app-core-server`, requiring mirror restoration. Required app-core-owner to fix and republish.
- Tried to enforce app-module naming-convention violations before confirming the rule was published in `@wadeck-app/violations-rules` — it wasn't; app-core-owner clarified rules live in repo-local `.violations/rules/`, not globally.
- Agent attempted to use deferred GitHub MCP tools (mcp__github-wadeck-app__actions_list, etc.) without fetching their schemas via ToolSearch first; resulted in repeated "NOT YET KNOWN" warnings instead of tool execution.
- Agent reported code review completion with an incomplete/cut-off JSON findings structure, suggesting premature conclusion before verifying the output was well-formed.
- Agent issued conflicting directives about temp file cleanup — ran `rm -f`, then said "skip the rm, leave the temp file" post-hoc, confusing the command execution timeline.
- Multiple deferred-tool schema failures: agent invoked EnterPlanMode (16:24), AskUserQuestion (16:54, 17:22), mcp__github-wadeck-app__actions_list (16:10-16:11, 17:23-17:25), and code-review skill (18:19) without ToolSearch pre-loading — pattern: must fetch deferred-tool schemas before complex workflows.
- Manually polled CI with sleep loops instead of using `/poll-ci` skill, which is designed for exactly this workflow (monitor run to completion after push)

<!-- session f76d9b35 2026-10-11 -->
- Attempted direct app-core-sdk type imports for ModuleContext but SDK only exports bundle.d.ts outside monorepo context; developer preference clarified to keep local mirror instead.
- MCP tool schemas for `mcp__github-wadeck-app__actions_list`, `mcp__github-wadeck__actions_list`, and related GitHub Actions tools repeatedly marked "NOT YET KNOWN" despite multiple invocations — indicates schema loading or initialization failure, not transient network issue.
- Two parallel long-running agents (c67aed0e: queue work; d9e5ed4e: poc-node deploy) led to 6+ minute deployment blockage on PM2 restart loop. Parallelization strategy not clear; high context switching overhead with minimal observed parallelism benefit in this case.
- mcp__github-wadeck__actions_list repeatedly marked "NOT YET KNOWN" despite being in deferred tools list—agent fell back to sleep + browser polling for CI status instead of using GitHub API; suggests MCP server connection delay or initialization issue.

<!-- session a6f2e7c7 2026-10-11 -->
- Agent created queue-app-module with root `dist/` export, then pivoted to `api-backend/` + `dsl-frontend/` separate builds mid-task after discovering app-core's layout. Should validate downstream consumer contract before initial structure.
- ModuleContext: created a mirror type copy, then deleted it, then restored it, then kept the mirror—vacillating due to uncertainty about whether to import real types from @wadeck-app/app-core-sdk or mirror them. Needs clear guidance upfront on SDK type strategy.
- agent-browser skill invoked without upfront understanding of daemon model / setup requirements. Diagnostic steps (--help, --version, ls, grep, source inspection) could have been avoided with clearer skill documentation on initialization or different launch syntax.
- Using MCP tools (mcp__github-wadeck*__actions_list, get_job_logs) before their schemas were loaded; marked "NOT YET KNOWN" repeatedly. Should ToolSearch before first use.
- SendMessage coordination with external agents (app-core-owner, dsl-owner, cap-owner) without confirmation or fallback if those sessions are unavailable; this pattern appears frequently but no error handling if agents don't respond.
- agent-browser skill triggered as "NOT YET KNOWN" (12:55:34), halting execution; session spent ~90s searching help/docs for correct launch command instead of executing immediately
- Multiple calls to deferred MCP tools (mcp__github-wadeck__actions_list, mcp__github-wadeck__get_job_logs) without prior ToolSearch fetch, appearing as "NOT YET KNOWN" warnings throughout

<!-- session 91f1ee99 2026-10-11 -->
- backend.ts was built against unverified unpublished SDK types, creating a partial implementation that broke CI. Type contract should have been confirmed async with app-core-owner before writing code (did happen via SendMessage, but too late in implementation cycle).

<!-- session 62eaddc2 2026-10-11 -->
- Deferred MCP tools (mcp__github-wadeck-app__actions_list) called repeatedly without loading schemas first via ToolSearch — tools marked "NOT YET KNOWN" at 08:45:10, 08:45:33, 08:58:20, 09:08:02, 09:08:30, 09:09:09.

<!-- session 8aa7c2ee 2026-10-11 -->
- Called write-doc skill and mcp__github-wadeck-app tools without loading their schemas first (shown as "NOT YET KNOWN" warnings)
- Used manual CI polling with hardcoded sleeps (12s, 15s, 30s waits) instead of the poll-ci skill already available
- Attempted to install unpublished @wadeck-app/app-core-sdk dependency; had to revert after discovering it was not on the registry

<!-- session 3867af81 2026-10-11 -->
- Called mcp__github-wadeck-app__actions_list repeatedly (08:57:16, 08:57:41, 08:58:20, 09:08:02, 09:08:30, 09:09:09) with "NOT YET KNOWN" warnings each time instead of fetching schema via ToolSearch after first failure.
- Used sleep-based polling (12s, 15s, 30s intervals) to wait for CI instead of poll-ci skill or direct GitHub Actions checks; contradicts user instructions on avoiding sleep loops.
- Attempted write-doc skill and ToolSearch calls without fetching their schemas first, then proceeded without them; inconsistent with the pattern used successfully for SendMessage (ListAgents → ToolSearch → call).

<!-- session 3126a802 2026-10-10 -->
- Assistant ran code review against `main...HEAD` (empty diff) instead of the correct commit range; didn't realize all commits had already been pushed. Check git status and commit locations before triggering reviews.
- Subagent delegated npm build/test with tail output truncation — early failures in npm install hidden; agent should report actual error lines from stderr, not truncated context.

<!-- session 42863e84 2026-10-11 -->
- App-core integration requirements discovered incrementally via back-and-forth messaging rather than upfront contract review; restructuring (api-backend/dsl-frontend layout) needed after initial implementation.

<!-- session 8a40edb8 2026-10-11 -->
- Agent assumed `queue-app-module` should export from root `dist/`, then had to restructure to `api-backend/` + `dsl-frontend/` separate builds—app-core's layout wasn't known until mid-task exploration.
- Agent added `@wadeck-app/app-core-sdk` as a dependency without confirming it was published; message later confirmed "app-core-sdk not found on registry"—dependencies that don't exist should fail fast, not silently during install.

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

<!-- session fc140a04 2026-10-25 -->
- Protocol versioning system (contract files, PROTOCOL_VERSION, daemon compatibility checks) required extensive grep/read exploration across multiple files; naming conventions and version update procedures are not immediately clear.

<!-- session 53a72f6b 2026-10-25 -->
- write-doc skill not loaded when attempted at 20:23:39 — user worked around with Write tool directly. Skill loading may need better error handling or pre-loading for docs task patterns.
- Registry/ConfigLoader/subscribers interconnections required extensive codebase exploration (grep/sed at 16:03-16:08) before implementation — architecture not immediately clear from existing docs or code comments.
- Pending page layout required multiple screenshot iterations and DOM inspection (20:20-20:21) — visual behavior/layout not fully specified upfront, necessitated real-app testing to validate design.

<!-- session 4ff1a10a 2026-10-24 -->
- Test timeout/fragility patterns (setTimeout, Date.now, hardcoded delays) not documented; guiding-principles.md updated reactively (09:45:44) but no proactive guide for teams on which patterns to avoid.
- SDK testing helpers (makeTempDir, removeDir, closedPort, waitFor) duplicated across packages; no centralized API or pattern guide—each package reinvents with inconsistent signatures.
- File rename (waitFor.ts → testWaitFor.ts) required scattered sed-based import updates, suggesting the module's role/location wasn't obvious from context. No clear guidance on test helper file naming or structure.
- Protocol version bumps from 1.0.0 → 1.1.0 require cascading updates across docs/push-protocol.md, README.md, packages/queue-sdk/README.md, and guiding-principles.md. No central pattern documented; updates are manual and error-prone.
- Node script pattern (multi-file coordinated edits in temp files) and BUNDLE_VERSION markers used extensively but not documented in project CLAUDE.md. DSL component discovery requires cross-workspace grepping (no centralized reference).

<!-- session ca620a5a 2026-10-24 -->
- The waitFor/condition-based-wait pattern for replacing setTimeout-based test flakiness should be documented for future test improvements; this chunk shows systematic replacement but no explicit record of the pattern.
- ciWait*/ciGit*/ciInfer* files marked "to be replaced by unit tests" with no docs on replacement strategy or migration path — ambiguity caused a "do not touch" message mid-refactor.
- Protocol version bumps (1.0.0 → 1.1.0) require scattered manual updates across README/docs/contracts/type defs/tests — no automation or lint rule prevents incomplete bumps; process should be runbook'd
- Multiple SendMessage calls requesting upstream features before implementation could be completed: dsl-ui Markdown component, DataTable tooltips, icon support on YAML row actions, then dsl-ui version constraint (>= -172). Features were needed mid-implementation, blocking progress until other projects delivered.

<!-- session 29f6efb2 2026-10-24 -->
- The deflaking pattern (condition-based waits instead of wall-clock timeouts) required updating guiding-principles.md mid-work; agents needed to discover and codify this pattern by reading existing test code rather than having it documented beforehand.
- DSL renderer (CompactSelect, badge conditions) documentation scattered across dsl-view project; agent a561 had to search external workspace instead of finding it locally
- Initial task delegations to sub-agents used vague terminology ("5 negative N-ms checks", "injected signals") without file paths or line numbers, requiring sub-agents to search the codebase to understand scope; follow-up messages clarified requirements
- Cross-workspace coordination requires multiple SendMessage calls to different owners (dsl-owner, app-core-owner, etc.); orchestration pattern suggests missing unified dependency/blocker documentation.

<!-- session 93cf3ce8 2026-10-18 -->
- Module directory structure (src/backend, src/dsl-views) had to be inferred from app-core's module-authoring.md; queue project's CLAUDE.md doesn't explain this constraint.
- Violations rules misconfigured or too strict — multiple retries adding suppressions. Rules aren't documented or don't match the project's code shape.
- `request-bypass.js` script usage (called with `--category git-commit`) is undocumented; unclear if this is a standard tool or a workaround the agent invented

<!-- session 0b8f766f 2026-10-18 -->
- write-doc skill invoked at 14:20:07 but not yet loaded ("*** NOT YET KNOWN ***") — halted documentation update mid-refactoring.
- App-core module manifest structure was unclear: the `"id"` field in manifest.json is required but not obvious until rejected by CI/violations rules; the dual-location sync requirement (source vs installed `dist-module/app-module/`) was discovered through trial.
- Module file organization (backend vs dsl-views split, which files go where) required trial-and-error directory restructuring; should be documented in module-authoring.md.
- Relay on-demand behavior (starts when needed, stops when idle) vs auto-start expectations on boot: not clearly documented; required investigation into logs and lifecycle to understand actual behavior.

<!-- session 1f6af8e0 2026-10-18 -->
- app-core module directory structure (src/backend and src/dsl-views split) required reading external docs and trial-and-error; no upfront validation that source layout matches expectations
- manifest.json "id" field requirement for app-core modules caused registration failure; should fail earlier or be documented more prominently
- app-core bundling/packaging contract (BUNDLE_VERSION env var, dist-module output structure, import_meta handling) had to be reverse-engineered from integration tests

<!-- session de7e2366 2026-10-18 -->
- Searching for cross-repo patterns (without-daemon, registerWithAppCore, restartDaemon) took multiple grep rounds — architectural decisions like "queue-core is pure logic, registration moves to queue-cli" and "app-core SDK registration happens at update-time" should be documented in `.claude/product-vision.md`.
- app-core module authoring checklist not explicit: "id" field in manifest.json was required by app-core 2026.10.18+ but not caught until app-core rejected the module; src/backend + src/dsl-views layout was inferred from app-core-sdk docs, not stated as mandatory in project docs.
- Violations rules for generated artifacts (dist-types/, api-backend/, dsl-frontend/) not pre-configured; had to manually add exclusions to .violations/config.ts and barrel-index suppression comments after violations check failures.

<!-- session e3a1928e 2026-10-18 -->
- Extended grepping for `without-daemon`, `with-daemon`, `RestartDaemonConfig` (12:38–12:45) suggests unclear integration patterns between CLI updater, daemon lifecycle, and app-core SDK registration.
- App-core-sdk usage requires reverse-engineering from `node_modules/@wadeck-app/app-core-sdk/dist` (12:50:37); usage patterns should be documented in the SDK, not discovered through debugging.

<!-- session ebf8428c 2026-10-18 -->
- Queue-core/queue-cli/app-module-queue package boundaries and responsibility split not upfront — led to 30-minute refactor (12:40-12:51) moving AppCoreRegistration, then user clarification at 13:14
- Which queue operations (push/replay/dlq/reads) accessible from module vs CLI vs daemon — required user question at 14:47
- Configuration directory ownership: initially lived in app-module-queue, moved to queue-core at 13:09 without clear spec

<!-- session 19baf9ca 2026-10-17 -->
- poll-ci skill was poorly documented, leading to late-session SKILL.md creation/update (17:46:07–17:46:18) to clarify usage and integrate it with CLAUDE.md guidance.

<!-- session ce5be425 2026-10-17 -->
- Build system knowledge (npm workspace pretest rebuild of queue-core, BUNDLE_VERSION bundling, dist/ output paths) was reverse-engineered during implementation, not documented upfront in project CLAUDE.md or setup docs.
- Browser testing harness (agent-browser with fixture generation via make.mjs) required ad-hoc fixture creation; no template or documented pattern for this workflow.

<!-- session 75764a93 2026-10-17 -->
- Fixture generation process (create temp dir, write make.mjs generator, execute) is ad-hoc and undocumented. Used at 09:50:04 and later but no reusable pattern exists — should be extracted as a fixture utility or helper.

<!-- session b342b025 2026-10-17 -->
- `queue wait ci` is a new public command but README is only updated near session end, after implementation. Internal docs on how CI wait should integrate with relay/webhook events appear missing.

<!-- session 5ea726b4 2026-10-14 -->
- The queue CLI's bin-launcher silently daemonizes stdout/stderr (separate file handles) when called through the shim — this caused confusion when piping the command failed. The daemon has no unit-test harness, only end-to-end coverage via queue-cli integration tests, which should be stated upfront.
- `_secrets_` directory convention for storing tokens was unknown; assistant had planned `token:` field in `relay.yml` instead.
- Webhook relay API contract unclear: `webhook-history` endpoint behavior (events vs. metadata only) required live testing to clarify.
- DSL YAML documentation for HorizontalStack unclear: accepts TAILWIND CLASS values like `gap: gap-3`, `align: items-center`, not just raw values; coordinator had to correct this.
- How to create and seed NDJSON history test files with specific entries (event structure, format, timestamps) is not documented in existing test examples.
- Output format tests coupled to exact field strings; adding fields to test data breaks string-matching assertions
- The `RelayClient` interface and error types (`RelayConnectionError`, `RelayStopError`) are not documented in the queue-relay-client module's README — developers must read types directly to understand the stop behavior and error cases.
- Filesystem error testing unreliable on Windows/POSIX (renaming to directory path doesn't consistently trigger errors) — no guidance led to complex test attempts eventually abandoned for simpler approach.
- Test file naming, structure, and pattern conventions aren't documented. Required reading multiple existing test files to infer TestContext usage and log-capture patterns.
- Node.js daemon async cleanup contract unclear: wasn't specified whether on-error paths must call stop() before exit(1), or whether frameworks handle it automatically (they don't).
- D6b: Test specs should have called out explicit warning string assertions upfront ("no recorded working directory" vs "recorded working directory ... no longer exists"). First pass tests were vague.
- T1: Spec could have clarified that PASSTHROUGH_FLAGS is declared but unused at the template call site (important distinction from "used but treated specially").
- Relay daemon output stream (stdout vs stderr) not obvious from implementation — required manual testing and debugging to discover.
- Build artifact versioning: bundle.ts doesn't automatically propagate manifest.version into compiled dist-bundle/queue.cjs — requires explicit write step that isn't documented, only discovered when browser showed stale pages.
- `.claude/threat-model.md` needed update after token/secrets implementation, suggesting auth-failure policy wasn't fully analyzed upfront.
- WebSocket autoPong behavior in ws library and its interaction with relay reconnects may need internal doc; multiple agent cycles suggest this isn't obvious to future work.

<!-- session f8709619 2026-10-17 -->
- Extensive research into Claude Code wake-up mechanisms (channels, scheduled tasks, hooks, cross-session messaging, remote control, headless mode, agent SDK subagents) suggests no clear pattern docs for "wait for external GitHub CI completion" — a common need that should be pre-documented with examples.

<!-- session d9e5ed4e 2026-10-11 -->
- Infomaniak's deployment model (platform supervisor runs `npm start` independently of PM2 daemon) was not documented or understood upfront, leading to multiple wrong theories.
- PM2's ecosystem.config.cjs behavior and how `npm start` bypasses it entirely were not obvious — user had to explain the root cause of the whole debugging session.
- File-based secrets (write once via SSH, read at runtime) vs. environment-variable secrets (set in CI platform) distinction not documented in deployment patterns — led to back-and-forth on feasibility.
- w-guardrails bypass system behavior (CWD sensitivity, grant file location, hook categorization of `git-commit` vs `git-commit-push`) not obvious; took multiple failed attempts to surface.
- App-core-sdk requires bundled types (`index.bundle.d.ts`) for out-of-monorepo usage; plain `index.d.ts` fails type resolution when queue-app-module is installed as a workspace package.
- ModuleContext mirror pattern: even after moving to SDK, must keep `src/moduleContext.ts` as a fallback since types leak into compiled output; removing it breaks despite passing type checks.
- No docs on compute-version breaking-input behavior or when the flag is/isn't honored across different trigger events.
- No clear guidance on whether queue-app-module and queue-cli should pin `@wadeck-app/*` deps to exact versions or track `latest`.
- naming-convention violations rule not found in config — agent escalated to app-core-owner for clarification; rule definition or wiring is missing/undocumented.
- SendMessage to app-core-owner asking about daemon auto-registration design contract (16:15:21) suggests the registration startup flow lacks clear documentation for expected behavior.
- Extensive multi-search-engine attempts for "SSH exit 255 no output" and Infomaniak hosting restrictions — search results were not satisfactory; Infomaniak-specific troubleshooting (SSH pty restrictions, scp as workaround) should be documented
- Pagination pattern for queue history (CLI and dashboard with $sources) is unclear; assistant delegated research to other projects (agent-fleet, task) to find reference implementations rather than locating local patterns.
- New workspace packages lack a documented template or pattern; assistant inferred tsconfig.json, vitest.config.ts, and src/index.ts structure by repeated file-by-file examination rather than following an explicit template.

<!-- session ebbc5644 2026-10-17 -->
- App-core backend integration contract (API backend structure, dsl-frontend layout, manifest.json schema) not pre-documented — verified via SendMessage inquiry rounds to app-core-owner and dsl-owner
- Queue-relay-client passes daemon script via QUEUE_DAEMON_SCRIPT env var; standalone-entry.ts was deleted to confirm this. Should document relay injection contract explicitly
- Shared-cli exports and available utilities (diffSnapshot, Duration, CliMetaCommands) not discoverable without reading node_modules/@wadeck-app/shared-cli/dist/*.d.ts — should document public API in workspace README or CLAUDE.md

<!-- session ef0bc44d 2026-10-17 -->
- Lessons being appended to `.claude/kb/lessons-learned.md` are truncated in command log output ("An isolated app-core test instance still wri...") — unable to see the full lesson captured.

<!-- session dadc38c4 2026-10-17 -->
- Windows path format handling in integration tests unclear—session cycled through /c/, C:\\, and C:/ formats; no guidance on which test framework requires which format.

<!-- session 3ade944d 2026-10-14 -->
- vitest.config.ts created/updated mid-session (19:03:22) with non-trivial setup (PORT, APP_CORE_CONFIG_DIR, env vars); suggests test infrastructure docs or initial workspace config was incomplete or out-of-date.
- User had to create offline relay.yml validation script (21:01:04) and inspect.mjs (21:24:40) to understand relay API structure; no clear documentation of webhook-history endpoint format in existing docs

<!-- session adc6a0d7 2026-10-14 -->
- Multiple cross-repo coordination via SendMessage calls but no visible sync protocol documented.
- Relay.yml schema/structure not obvious from code; user had to create test fixture manually and validate separately rather than being guided by generated tests
- websocket ping/pong behavior with autoPong and relay reconnect wasn't clearly documented — agent had to inspect ws package.json and .d.ts to confirm feature availability; future PRs should state ws version requirements upfront if relying on specific features.

<!-- session c1d3d375 2026-10-14 -->
- secrets discovery pattern unclear: agent had to cross-reference other projects (scrapers, whatsapp-scraper) to find `_secrets_/.env.local` convention; no canonical docs for queue-relay-client token loading.
- Integration test environment setup: vitest.config.ts required per-package configuration (env var injection, process.env spread) to unblock integration tests against external daemons; pattern not documented in CLAUDE.md.
- agent-browser session lifecycle: multiple timeouts and retries suggest timing/lifecycle docs missing; unclear when sessions stabilize and how long to wait before first commands.
- No clear guidance on testing WebSocket ping/pong + relay restart resilience end-to-end — currently requires both vitest runs AND manual browser session recreation with screenshot diffs

<!-- session 08232271 2026-10-14 -->
- Agent a03e inspected poc-node relay routes.js directly to understand webhook delivery structure (stats, verified24h fields) — relay webhook API contract not documented as part of queue-relay-client public API.
- Agent had to inspect node_modules/ws manually to verify autoPong support — ws version/capability constraints should be documented (e.g., in `.claude/guiding-principles.md` or a dependencies reference).

<!-- session 8e9c2749 2026-10-14 -->
- App-module-queue backend contract requires reverse-engineering app-core's ComponentRegistry, manifest.ts, and moduleContext — API should be documented or exposed in dev tooling.
- Integration tests require explicit environment setup (QUEUE_CONFIG_DIR env var, specific vitest config with isolate/threads). Defaults don't work; setup steps not obvious from test files.
- Threat model documentation became stale when relay feature extended (user updated .claude/threat-model.md after new commands shipped).
- Agent had to inspect POC code (poc-node routes.js) to understand webhook schema — no single source of truth for expected relay API shape in queue repo.
- App-core module registration via manifest.json on Windows requires specific path format (forward slashes), but no error message or guidance shown when paths are malformed — should fail with actionable error instead of silent 404/registration failure.

<!-- session bf5f59b2 2026-10-14 -->
- App-core module registration contract is implicit: requires reading ComponentRegistry.ts, manifest.ts, moduleContext.ts, DSL contracts, and app-core loader cache semantics — no single source of truth for "how to integrate a new module"
- Token value handling and security exposure not clearly contracted — user manually investigated token printability (20:58 grep for "token", "refused the token") then updated threat-model.md, suggesting relay.yml config/secrets handling rules should be explicit.

<!-- session 51a43681 2026-10-14 -->
- Vitest isolation config (APP_CORE_CONFIG_DIR, APP_CORE_PORT) not initially set up; had to create vitest.config.ts mid-session to prevent test interference.
- Import case-sensitivity linting (Windows/Linux mismatch) — agent had to write a check script (19:02:30) to proactively catch this. Should be CI linting, not manual tooling.
- Relay webhook API structure (stats, verified24h, delivery fields) reverse-engineered from POC code in `/c/Workspace_Other/poc-node/lib/relay/routes.js`. Create API spec or docstring contract for relayApi.ts.

<!-- session c7e64025 2026-10-14 -->
- App-core module loader cache invalidation (manifest.version as cache key) not documented; assistant had to discover via grep
- Platform-specific errno behavior (_ENOENT vs ENOTDIR on Windows vs Linux_) not centralized in test docs; required manual investigation of RelayLogger.test.ts
- Relay API webhook response format not self-evident — user inspected POC routes.js to understand stats/verified24h fields
- Integration test sequencing requirement (must run sequentially, per commit history) not flagged upfront

<!-- session c6b7adc0 2026-10-12 -->
- App-core integration contract (API backend structure, dsl-frontend layout, manifest.json schema, backend.ts shape) was confirmed via SendMessage inquiry rounds rather than pre-documented — caused mid-task discovery cycles instead of upfront clarity.

<!-- session ddaa4cf0 2026-10-11 -->
- agent-browser command syntax not discoverable — trial-and-error sequence with --help, --version, install, then open/wait/snapshot/get text/get html; no inline help or usage pattern docs for browser automation.
- CalVer versioning pattern and compute-version's breaking-input contract were not formally documented — discovered only after silent discard bug required fix.

<!-- session 8ae2c774 2026-10-11 -->
- ModuleContext shape, Manifest structure, extensionPoints registration, backend handler mocking patterns, and SDK type export variants (monorepo vs npm) all required exploration of app-core/dsl-view repos; no canonical reference for these integration points exists in queue project docs.
- `kb` skill invoked but shows "NOT YET KNOWN"; user worked around by directly editing .claude/kb/lessons-learned.md instead of using the skill

<!-- session 50367f0a 2026-10-11 -->
- Module structure contract (api-backend/ vs dsl-frontend/, manifest.json shape, backend entry point shape) required deep cross-repo exploration; no documented template or checklist available upfront.
- Cross-repo coordination needed: dsl-renderer/dsl-ui versioning strategy (pin vs latest) required SendMessage rounds to clarify with other project owners — no shared versioning policy doc.
- agent-browser session management unclear—at 12:55:34–12:56:45 assistant spent ~11 minutes searching README, environment variables, and daemon options, trying to diagnose why browser wasn't launching. No upfront guidance on browser binary installation (`agent-browser install`) or session state requirements.
- When poll-ci skill unavailable, agent fell back to manual sleep-loop polling (30s-100s waits) instead of explicitly flagging the skill was missing or trying ToolSearch to load it.

<!-- session c67aed0e 2026-10-10 -->
- Inter-agent plan discussed `queue-app-module` scope ambiguously, leading to clarification round-trips and conflicting interpretations of whether it belonged in this workspace.
- SDK split into types-only package (`app-core-sdk`) + CLI binary (`app-core-cli`) wasn't communicated upfront; design rationale (versioning, decoupling) emerged only via user questions.
- `violations` CLI operates on repo-local `.violations/rules/`, not just published rules — this was a significant blind spot when asked to verify a naming rule.
- Directory structure of sibling repos under C:\Workspace_Tooling was not self-evident; user had to explicitly guide search to locate `dsl-view` repo (not `dsl-renderer` directly).
- Violations config glob patterns for npm workspaces unintuitive — agent spent 8+ minutes researching how to exclude nested `**/packages/*/node_modules/**` after moving packages into subdirectories.

<!-- session f76d9b35 2026-10-11 -->
- SDK's dual export model (monorepo internal types vs external bundle.d.ts) not documented — discovery required reading dist/ contents and package.json types field manually.
- `compute-version` action silently discards `breaking-input` flag on non-manual triggers (bug fix was required). Behavior was not documented; discovered only via targeted investigation.
- CalVer versioning convention required git-history inspection to reverse-engineer; no spec or design doc explicitly states version scheme across projects.
- Violations rule naming-convention not wired into @wadeck-app/violations-rules; agent found rule missing mid-check, had to pause for clarification from app-core-owner on rule availability.

<!-- session a6f2e7c7 2026-10-11 -->
- Had to spawn Explore agent to discover DSL vocabulary, schema files, and view structure across dsl-view/app-core projects. DSL contract and manifest layout expectations for queue-app-module were not documented in a discoverable way.
- CalVer versioning convention not documented in project lessons — discovered during this session by investigating compute-version.sh history across multiple repos; should be added to `.claude/kb/lessons-learned.md`.
- kb skill not loaded/available (12:45:55), forcing manual kb directory discovery and direct file edits as fallback

<!-- session 91f1ee99 2026-10-11 -->
- DSL file layout (views/ → api-backend/dsl-frontend/) required cross-project exploration and coordination; no pre-existing pattern document in queue/.claude/. Should document or confirm app-core's manifest/views structure before implementing queue-app-module backend.

<!-- session 62eaddc2 2026-10-11 -->
- Manual CI polling with sleep loops (12s, 15s, 30s, 10s repeating) instead of using available poll-ci skill — 5+ wait sequences totaling 2+ minutes of sleeps across the session.

<!-- session c240569c 2026-10-11 -->
- Queue-app-module implementation required reverse-engineering app-core's backend/DSL contract by reading ComponentRegistry.ts, manifest.ts, and moduleContext.ts — suggests API contract and layout conventions need better discovery (README, docs, or type exports).

<!-- session 8aa7c2ee 2026-10-11 -->
- Module structure contract (backend.mjs + manifest.json + DSL views layout + ConfigDir shape) required cross-project exploration and real-time clarification from app-core-owner instead of being documented

<!-- session 580bfde8 2026-10-11 -->
- App-core integration contract (api-backend/dsl-frontend layout, backend.ts shape, manifest.json schema) was confirmed via SendMessage rounds rather than pre-documented — caused mid-session restructuring when app-core-owner clarified folder rules.

<!-- session 3126a802 2026-10-10 -->
- Violations config glob behavior with nested workspace packages not documented — monorepo glob handling should be in .claude/guiding-principles.md or violations docs.

<!-- session 42863e84 2026-10-11 -->
- ModuleContext/manifest/ConfigDir API contracts undocumented — required reading node_modules and app-core source to reverse-engineer integration shape.
- DSL schema/component registration ($type dispatch, ComponentRegistry, backend→frontend wiring) requires cross-project file reading; no unified integration guide.

<!-- session 8a40edb8 2026-10-11 -->
- No documentation on `queue-app-module` directory structure expectations relative to app-core's `api-backend/dsl-frontend` layout conventions; required Explore agent to reverse-engineer from app-core fixtures and dsl-view source.

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

<!-- session fc140a04 2026-10-25 -->
- Project adoption implementation requires explicit user decisions (SDK vs. config strategy, adoption order) before proceeding — scope question at 14:20 blocked progress until confirmed.

<!-- session 53a72f6b 2026-10-25 -->
- CRLF line ending issue caught during test file review at 2026-10-25 14:06:41 — Windows Git Bash platform gotcha when working with test files

<!-- session 4ff1a10a 2026-10-24 -->
- Version management scattered: BUNDLE_VERSION env var, package.json, embedded in daemon code—no single source of truth discovered; investigation at 08:03:23-08:04:54 showed confusion across multiple grep attempts.
- Browser-based dashboard testing via manual agent-browser screenshots (choice1-3, logs1-4, ov1, hist1-2 at 09:15+); no structured UI test framework; visual regression is manual.
- Windows temp directory cleanup for `queue-replay-cwd-*` dirs requires intervention (cmd //c attrib), blocking normal rm/rmdir. This recurring pain point deserves a documented workaround or cleanup script.
- Timing-dependent tests are expensive to eliminate: the RelayConnection.test.ts refactoring (13:18–13:26) replaced five sleep checks with injected signals via six helper scripts (.mjs files) and required manual SendMessage orchestration. Injecting test barriers is the pattern, but it scales poorly.
- Integration tests (relayEndToEnd.integration.test.ts, QueueSdk.integration.test.ts) depend on external services (relay daemon, queue daemon) running and properly configured. Load testing during test runs (node load.mjs 300000 concurrent) adds latency sensitivity and flakiness risk.
- dsl-ui Markdown node requires version >= -172; DataTable cell tooltips documented as future work. Blocking dependencies communicated proactively via SendMessage to stakeholders.

<!-- session ca620a5a 2026-10-24 -->
- Some packages (queue-relay-client) lack vitest.config.ts; agents added it when setting up test deflaking infrastructure.
- Test utilities (waitFor.ts) created per-package in testing/ subdirectories rather than shared, suggesting each package handles its own test infrastructure setup.
- Windows temp directory cleanup fails (queue-replay-cwd-* dirs stuck; required manual `attrib /D` commands) — POSIX rm patterns don't fully work under MSYS2; needs explicit Windows cleanup logic.
- Heavy use of sed -i commands for code patching without explicit success verification or retry logic — creates risk of silent failures; agents work around bash complexity limits by creating temporary .mjs patch files instead of inline shell
- Queue project has tight coupling to @wadeck-app/dsl-ui and app-core versions. Feature implementation was gated by cross-project capability availability (Markdown renderer, cell tooltips, row action icons), requiring explicit requests and version upgrades from other teams.

<!-- session 29f6efb2 2026-10-24 -->
- Tests are heavily machine-speed-dependent; session implements complex logical-clock + synchronization system as workaround rather than fixing root timing issues
- Agents created temporary .mjs scripts for complex orchestration of multi-file test modifications (RelayConnection seams, catalog setup) rather than sequential Edit calls—worth documenting whether this pattern indicates legitimate need for batch orchestration or opportunity for simpler approaches
- Heavy reliance on cross-workspace packages (dsl-ui >= required version, component APIs) creates coordination bottlenecks — work blocked waiting for upstream dsl-ui version before proceeding with Markdown/tooltip features.
- Guardrails blocking git-commit operations; bypass bypass requests required (seen in final guardrails log).
- Complex file edits performed via scripted .mjs files in temp directories rather than direct file operations — suggests programmatic transformation pattern for multi-file coordination.

<!-- session 93cf3ce8 2026-10-18 -->
- Inconsistent CI waiting: mixed `sleep` loops with `queue wait ci`; should standardize on poll-ci skill to avoid wasting cache between rounds
- Relay daemon doesn't auto-start after system reboot; no autostart mechanism configured.

<!-- session 0b8f766f 2026-10-18 -->
- User asks design questions in French (CLAUDE.md: English-only output) — potential for miscommunication when architectural decisions (package deps, module scope, WAL contracts) are discussed in mixed language.
- Manifest versions must stay synchronized across source and bundled output locations; changes in one require verification/update in the other, or routes/code disappear from the live module.
- Violations rules can reject new module manifest formats; published rules may flag valid local changes as violations until the rule version is bumped.

<!-- session 1f6af8e0 2026-10-18 -->
- Large structural refactoring (file moves, package deps, config extraction) spanned ~35 min; required multiple test cycles and careful sequencing of git operations with CI waits between commits
- Published violations rules can reject new code patterns retroactively; shared-cli's rule about "source manifest" started failing when module manifest was reorganized — required coordination with external owner
- On-demand relay lifecycle required coordination between RelayDaemon, waitCli, and onDemand modules; initial design was incomplete and needed refactoring mid-stream
- FileLock concurrency tests run in a loop (12 iterations) on transient failures—Windows-level error handling (EPERM/EBUSY/EACCES) retry behavior is implicit
- Relay daemon stops itself when on-demand marker is removed; this behavior must stay documented in guiding-principles.md to avoid confusion

<!-- session de7e2366 2026-10-18 -->
- Package dependency tree has specific rules ("queue-cli must not depend on app-core-sdk"; "app-module-queue depends on queue-core but not queue-cli") — these should be captured as explicit dependency audit rules or violations checks, not discovered via user clarification mid-implementation.
- app-core-cli check → bundle → real server test cycle is required for validation, not obvious from docs; multiple round-trips to verify correct packaging, especially import_meta handling in the bundled .cjs.

<!-- session e3a1928e 2026-10-18 -->
- Multiple WAL storage iterations (14:16–14:18) fixing newline inconsistencies; existing code lacked clear formatting conventions — agent had to debug rather than follow patterns.
- Daemon state is complex and timing-sensitive (config dirs, health files, socket state); registration changes are observable but not well-documented in logs or daemon output.

<!-- session ebf8428c 2026-10-18 -->
- Daemon registration with app-core requires understanding 5+ interdependent surfaces: app-core SDK, shared-updater strategies, registry/routes/loader in app-core, QueueDaemon lifecycle, and cli update entry point

<!-- session 9d143482 2026-10-18 -->
- bash.exe.stackdump files generated during bash operations on Windows; requires explicit `rm` + `.gitignore` update (already documented in user CLAUDE.md, but cleanup pattern is manual not automatic)

<!-- session 4047e640 2026-10-18 -->
- Windows bash generates `*.stackdump` files that should be in .gitignore to prevent them from polluting the repo; this appears recurring per recent commit message

<!-- session 6b2405c4 2026-10-18 -->
- Windows bash.exe.stackdump crash files need .gitignore entries (project reference: windows-hidden-process.md)

<!-- session 19baf9ca 2026-10-17 -->
- Browser automation (agent-browser) sessions can leave orphaned processes requiring manual taskkill cleanup (10:41:26); should detect stale sessions at startup or add explicit close/cleanup hooks.

<!-- session ce5be425 2026-10-17 -->
- MCP GitHub tools require pre-loading: repeated `*** NOT YET KNOWN ***` errors on mcp__github-wadeck-app__actions_list/get/get_job_logs. These must be fetched via ToolSearch before use, not discovered mid-execution.
- Skills also lazy-load: write-doc and poll-ci showed `*** NOT YET KNOWN ***` on first reference.

<!-- session 75764a93 2026-10-17 -->
- Long blocking sleeps (100–110 seconds) for CI (09:56:08, 09:59:41, 17:28:30, 17:32:01) are unavoidable bottlenecks. The poll-ci skill (17:46:07 onwards) is being introduced to replace manual waits — future sessions should prefer `poll-ci` over hardcoded sleep.

<!-- session 179c5926 2026-10-17 -->
- Poll-wait pattern inefficient — used blocking `sleep 100`/`sleep 110` for CI rather than `queue wait ci` with event-driven notification from start; background waits should leverage the relay/daemon architecture already in place.

<!-- session ac4c2b8f 2026-10-17 -->
- GitHub Actions MCP tools (actions_list, actions_get, get_job_logs) must be fetched with ToolSearch before use—they start as "NOT YET KNOWN" and cause repeated warnings if called directly.
- The write-doc skill triggered "NOT YET KNOWN" at 17:25:16, suggesting deferred-tool loading happens on first reference, not proactively.

<!-- session b342b025 2026-10-17 -->
- Deferred tools (poll-ci, write-doc skills, GitHub MCP tools) initially show as "NOT YET KNOWN" and fail; system resolves them but causes extra round-trips. ToolSearch needs explicit "select:" queries but can't be called from deferred contexts proactively.
- Permission bypass scripts called manually repeating across task (git-commit, skill-write, kill-port, cross-home, git-commit again). Suggests certain Bash + permission combinations not pre-approved in settings.

<!-- session 5ea726b4 2026-10-14 -->
- Guardrail hook blocks inline `node -e` commands; prebuilt bundles and .test.js artifacts in dist/ can cause tests to run twice if vitest config isn't explicit about include/exclude patterns.
- Process leak: multiple agents spawned relay daemons in tests but never stopped them; five survived until manual cleanup via taskkill.
- Cross-platform path handling: Node on Windows interprets POSIX `/tmp/...` as `C:\tmp\...`, causing config mismatches. Not caught in dev, surfaced during CI on Linux.
- js-yaml available transitively at workspace root but not listed in package.json of app-module-queue; safe to use via root node_modules.
- When rebuilding packages in workspace, dependent packages' dist/ must be current for type resolution in tests; run `npm run build` on queue-relay-client before running queue-cli tests that import from it.
- The `--offset` flag must error when combined with `--follow` (discovered during implementation and added as validation).
- Windows error handling differs—mkdir into file gets ENOENT, not ENOTDIR; tests require platform-aware error checks
- WebSocket library error messages for HTTP rejections (429/503) require regex detection; test setup must trigger actual upgrade attempts to see them
- Windows path format issues in E2E test setup (forward slashes vs. backslashes in QUEUE_CONFIG_DIR) make direct daemon testing complex — pragmatic approach was to verify via code review and existing test suite rather than end-to-end automation.
- Vitest mock type assertions are imprecise; tests had to use type workarounds (`as any`, `satisfies`) to preserve spy capabilities while satisfying TypeScript. Standard mock declarations lose type information and break later assertions.
- Pre-existing test failures in RelayConnection.test.ts and payloadMatch.test.ts made `tsc` exit with code 1 for the package, obscuring whether new code (push.ts, RelayLogger) introduced TypeScript errors or inherited them. This conflates signal.
- Workspace workspace pretest scripts rebuild dependencies, but dist/ types lag source during active development. Blocking type-check until rebuild completes, or typing against source, avoids repeated @ts-expect-error workarounds.
- Windows process cleanup: killing by port via `netstat` → `Stop-Process` fails silently; PowerShell `-Force -ErrorAction SilentlyContinue` needed, and even that sometimes leaves zombie process briefly listening.
- R8: Test timeouts must be at least 1500ms+ for exponential backoff with jitter to demonstrate 2 connection attempts; 500ms is too short.
- Windows temp directory cleanup requires retry/delay due to file locking; node.exe path conversion in vitest temp dirs complicates relative vs absolute path handling.
- Integration tests in queue workspace require environment setup (QUEUE_CONFIG_DIR, port lifecycle management) that makes isolation complex; tests can't be run in isolation on fresh clone without daemon teardown between test groups.
- Cross-workspace coordination needed: app-module-queue changes affect app-core module loader (manifest version), which affects dsl-ui pagination rendering, requiring end-to-end browser verification after CI passes — unit tests alone don't catch stale-import-cache bugs.
- Platform-specific test assumptions: RelayLogger.test.ts:282 expected ENOENT on Windows but Linux CI gave ENOTDIR; file-not-found error codes vary by OS and require explicit both-case handling, not generic error matching.
- Multiple app-core instances compete for ports; explicit port-availability check (netstat) required before each launch to prevent collision (PORT=4871 pattern).
- Npm workspace: `packages/queue-relay-client` pretest auto-rebuilds `queue-core` dist. `app-module-queue` is NOT an importable library—app-core loads it via `manifest.json` backendEntryPath; POST to `/api/modules` with file path to register.
- Threat model documents `subscribers.yml` command-injection risk; during this session, threat-model.md was updated alongside feature changes—security design is co-evolved, not retroactive.

<!-- session f8709619 2026-10-17 -->
- Session relies on custom skill development (poll-ci SKILL.md rewritten) and schema discovery via ToolSearch — tight coupling between agent research and skill availability suggests missing or incomplete tool metadata at session start.

<!-- session 3c886490 2026-10-17 -->
- GitHub Actions MCP tools (actions_list, actions_get, get_job_logs) consistently blocked as "NOT YET KNOWN" despite ToolSearch attempts; agent worked around using shell commands. Suggests tooling availability or schema loading issue requires investigation.

<!-- session a8b0f71b 2026-10-17 -->
- GitHub MCP tools (actions_list, actions_get, get_job_logs) cannot re-run a single failed job—only list/get/read jobs; agent had to work around this limitation.
- CLI agent used `sleep 100+` for CI completion waits instead of event-driven mechanisms (queue wait ci / poll-ci skill)—inefficient and wastes context/tokens.

<!-- session 7e05adc0 2026-10-17 -->
- CLI wait workflow evolved during session: early use of sleep/bash polling (09:56:08, 09:59:41, 17:28:30) replaced later with queue wait ci (17:29:39+), suggesting awareness or feature-availability gap at session start

<!-- session 69a576ad 2026-10-17 -->
- Session has 7+ hour gap (09:54 to 17:21); work resumed without summary, mid-feature, requiring re-discovery of file state (ciWait.ts, etc. already existed)

<!-- session 7de46642 2026-10-17 -->
- Avoid `sleep N` for CI waits (saw sleep 100/110 at 09:56:34, 09:59:41); use `queue wait ci SHA --repo owner/repo --timeout Xm` per poll-ci skill

<!-- session d9e5ed4e 2026-10-11 -->
- `pm2-runtime` no-daemon mode breaks reliable health-checks via SSH `pm2 jlist` — daemon never fully initializes, so queries return incomplete/empty results.
- Shell `$(...)` substitution silently truncates multiline SSH output — CI verification steps saw only first line of `pm2 jlist` JSON, hiding the full status.
- SSH rsync to Infomaniak hosting drops intermittently mid-transfer; solution is retry loop (3x attempts).
- Infomaniak hosting does not expose custom env vars — secrets must be written to files during SSH deploy and read by app.
- GitHub Actions + sshpass on Infomaniak shared hosting: SSH exec commands silently lose stdout (exit 255, no output) even when authentication succeeds, but `scp` works fine. No official Infomaniak docs confirm this restriction.
- Git-commit-push guardrail continued blocking even after multiple explicit bypass requests with correct approval flow, suggesting a bypass infrastructure issue unrelated to agent behavior.
- `request-bypass.js` grant file stored relative to CWD at request-time, not execution-time — grants made from session default dir didn't apply when cd'd to different project for git commands.
- agent-browser daemon fails to launch/connect reliably; multiple retry attempts (09:58–10:00) with different sessions all eventually timeout or stall, suggesting environmental or port-binding issues on Windows.
- Breaking-input flag in compute-version was silently discarded when `GITHUB_EVENT_NAME != 'workflow_dispatch'` — violates user's "never silent fallback" rule. Fix required commits to both ci-templates and main project.
- CI polling with repeated `sleep` commands (15s–90s intervals) to wait for deploy steps; PM2 restart got stuck 6+ minutes, forcing extended waits. Cross-project fixes (ci-templates + queue) meant multiple commit/push cycles before verification.
- Heavy sleep-poll pattern for CI status (12+ sleep commands, 15s–90s intervals) — indicates missing event-driven CI status wait; recommend `queue wait ci` or poll-ci skill over manual sleep loops.
- GitHub Actions CI status checking used synchronous polling with sleep delays (multiple 15s–100s waits, e.g., 15:19:00 onwards) instead of event-driven `queue wait ci` command.
- Guarddrails bypass requests (request-bypass.js) invoked multiple times for git-commit and kill commands — suggests these should be pre-allowlisted to reduce friction
- Workspace package linking resolves to `dist/` not source; multiple package.json and tsconfig reads suggest this pre-build behavior isn't immediately obvious despite being mentioned in CLAUDE.md.

<!-- session ebbc5644 2026-10-17 -->
- History UI regression testing is manual (agent-browser + screenshot comparison); not automated — design allows for fixture-driven testing but requires visual verification

<!-- session 6392f3bd 2026-10-17 -->
- Long CI waits (100–110s sleeps) are unavoidable for GitHub Actions; multiple `sleep` calls show this was expected but not optimized — consider event-driven wakeups (queue wait ci, poll-ci skill) instead of blind sleeps for future similar patterns.

<!-- session def50d20 2026-10-17 -->
- Deferred MCP tools (`mcp__github-wadeck-app__*`, `mcp__github-wadeck__*`) require explicit ToolSearch fetch before invocation — multiple `*** NOT YET KNOWN ***` warnings in the log when tools were called without schema loaded.
- CI publish-and-test cycle takes 100+ seconds; session used repeated `sleep 100` and `sleep 110` between commits and checks — factor this into future automation delays.

<!-- session 13321a8b 2026-10-17 -->
- Project has `queue wait ci <sha> --repo <owner>/<repo>` mechanism (via poll-ci skill) instead of sleep loops for CI polling; multiple sleep-based waits were used (09:56:08, 09:59:41, 17:28:30) despite CLAUDE.md explicitly documenting this pattern.

<!-- session 8ed25eec 2026-10-17 -->
- MCP tools (actions_list, get_job_logs, actions_get) repeatedly report "NOT YET KNOWN" after long sleep intervals (90s+); ToolSearch also returned "NOT YET KNOWN" once at [09:43:55]. Appears related to server connection pooling or startup delays on the Claude Code platform side, not user-side issues.
- Skills (e.g., write-doc) briefly returned "NOT YET KNOWN" at [17:25:16] despite being available in earlier parts of the same session, suggesting skill discovery may have transient availability windows during startup.

<!-- session 3c7a133b 2026-10-17 -->
- Bash session used `cd` statements (lines 5-6 tail, cat >>); project CLAUDE.md says avoid `cd`, use absolute paths instead

<!-- session ef0bc44d 2026-10-17 -->
- ToolSearch warns "NOT YET KNOWN" for deferred tools (SendMessage, ListAgents) even though they are available in the deferred list. Tools work anyway after the warning—false positive or timing issue in ToolSearch schema loading.

<!-- session 55ec4363 2026-10-17 -->
- MCP tools marked deferred in system-reminder require ToolSearch to load schemas before calling — calling them blindly will fail; no fallback or error handling shown for ToolSearch failures

<!-- session ae4adeff 2026-10-17 -->
- Deferred MCP tools (prefixed `mcp__*`) require ToolSearch with `select:<tool_name>` syntax before use. Invoking them directly triggers InputValidationError.

<!-- session 77fdc73f 2026-10-17 -->
- ToolSearch returns "NOT YET KNOWN" when fetching deferred tool schemas (SendMessage, ListAgents), but those tools remain callable afterward — safe to invoke them directly if ToolSearch fails

<!-- session bd9a10de 2026-10-17 -->
- Multiple deferred-tool schema failures mentioned in truncated assistant response (EnterPlanMode, AskUserQuestion, mcp__github-wadeck-app__actions_list) — unclear if this is a registration issue or a temporary connectivity problem that resolved after retry.

<!-- session 66130988 2026-10-17 -->
- SendMessage requires exact agent name from ListAgents output (user communicated targets as "app-core-owner" and "dsl-owner" — implied these are running agents in the same session, not external addresses).

<!-- session dadc38c4 2026-10-17 -->
- Port 47910 cleanup on Windows took 40+ poll cycles (~7 mins) after taskkill—background process shutdown delays, not instant; integration tests need longer teardown tolerance.

<!-- session 193146ba 2026-10-17 -->
- Integration tests generate hardcoded absolute paths (`/c/Workspace_Tooling/...`) requiring grep-based cleanup for portability; tests should use relative or temp paths instead.
- Port contention during integration test runs (47910, 47911, 4871, 4851); processes need explicit cleanup between runs (taskkill, netstat loops) to avoid flaky test isolation.

<!-- session 12f0593c 2026-10-14 -->
- Deferred MCP tools listed in system-reminder as "still connecting" surface as "NOT YET KNOWN" on first call, not as callable tools; ToolSearch does not unblock them. Fallback strategy needed: acknowledge limitation or implement max-retry + early bailout.
- Build configuration issue: test files auto-included in tsconfig build at 21:31, requiring manual exclusion fix mid-task. CI patterns for build exclusions may not be clearly documented.
- MCP tool `mcp__github-wadeck-app__issue_write` failed to load (21:21:57 WARN); aligns with system note that github-wadeck servers are slow to connect.

<!-- session 3ade944d 2026-10-14 -->
- Platform-specific errno values break cross-platform tests: RelayLogger.test.ts:282 expected ENOENT (Windows) but CI gets ENOTDIR (Linux), required manual fix and re-run.
- tsconfig.json in queue-relay-client needs explicit exclusion of integration tests from type-checking (21:31:47) to avoid circular dependency issues during build

<!-- session adc6a0d7 2026-10-14 -->
- Port management is critical for integration tests with dynamic allocation (4850-4852, 4870-4871); repeated netstat checks suggest race conditions.
- _secrets_ directory pattern used for env config across workspace; agents need to know this standard.
- MCP tools showed connection delays (~1 minute) before becoming available, causing polling delays instead of immediate access.
- Token values in relay.yml should not appear in logs or diagnostics; user manually verified relay.yml structure with offline validation script (21:01:23-21:01:29)
- Test setup pattern: APP_CORE_PORT=1 with mktemp config dir used to establish isolated test environment; this is the pattern for running CLI in test context.

<!-- session c1d3d375 2026-10-14 -->
- app-core module loader caches manifest.version; serving stale module until restart even after package update; tests running against real app-core need isolated port + fresh config dir.
- `.test.ts` files not auto-excluded from tsconfig.json build config — agent did not exclude them; CI runs with exclusion rule, causing local type-checking mismatches.
- Webhook relay features require manual browser automation for verification — unit tests insufficient; need visual confirmation of dashboard state after relay restarts (agent-browser screenshots were primary acceptance check)

<!-- session 08232271 2026-10-14 -->
- queue-cli deploys via CI→publish→`queue cli update`. Multi-hour CI cycle with dependent work streams; changes validated only after full publish cycle, not before.
- Multiple temporary validation scripts created (validate-relay-yml.mjs, claim-token.mjs, relay-inspect.mjs) for isolated relay config testing — config loading tightly coupled to live relay state; offline validation required to avoid interfering with production.
- WebSocket ping/pong handling (autoPong) is not obvious from ws package.json alone; version dependency or feature availability should be tracked.

<!-- session 8e9c2749 2026-10-14 -->
- Platform-specific errno handling: tests using errno assertions (ENOENT) fail on Linux with ENOTDIR. Need OS-agnostic assertions or documented per-platform test variants.
- relay.yml token values must never appear in logs/output; user created offline validation script and added explicit checks for this.
- Windows path handling in curl/curl commands for app-core module registration requires forward slashes only (`C:/path/to/manifest.json`), not mixed formats — multiple attempts with `pwd -W`, `sed`, and `${}` substitutions shown before arriving at correct format.

<!-- session bf5f59b2 2026-10-14 -->
- Session spawned two parallel agents that both touched secrets/config files; required coordination message ("will not stage your 3 pending files") to prevent conflicts — agents need visibility into overlapping work
- Platform-specific errno assertion (ENOENT on Windows, ENOTDIR on Linux) required environment-aware test fix; vitest.config.ts needed explicit QUEUE_CONFIG_DIR setup for integration tests; manifest version must be written during bundling to avoid stale app-core loader cache
- Tsconfig.json needs `"exclude": [..., "*.test.ts", "*.integration.test.ts"]` to prevent test files in build dist/ — emerged from relayApi implementation; likely needed across workspace packages.
- Windows path conversion in bash (pwd -W, sed tricks) unreliable; manifest loading requires hardcoded forward-slash paths (C:/Workspace_Tooling/...) instead of auto-converted ones

<!-- session 51a43681 2026-10-14 -->
- Stale import cache bug (bundle.ts not writing build version into manifest) caused module loader to serve outdated code silently — violates "no silent failures" rule. Cache-busting mechanism needs explicit version handoff.
- Port availability must be verified before starting isolated test instances (agent checking netstat, then binding to 4851/4852/4871). No auto-retry on port conflict.
- Cross-agent coordination via SendMessage (queue-owner, queue-gh-spec, app-core-owner, dsl-owner) requires explicit communication — tight loop of agent-to-agent status reports.
- Build-time tsconfig pattern: test files excluded from dist/ output. Each package's tsconfig.json has this; agents generating `*.test.ts` + impl should know it.

<!-- session c7e64025 2026-10-14 -->
- Parallel work across agents requires explicit file-staging coordination via SendMessage (e.g., "do not commit history.ts" at 20:53:04); no centralized signal for cross-agent file locks
- Windows: port/process lifecycle management (mktemp config dirs, netstat checks, process cleanup) critical for test isolation; no reusable helper pattern documented
- Token/secret error messages require special care — multiple fixes to "refused the token" phrasing to avoid leakage
- MCP servers (github-wadeck-app) may still be connecting — treat as transient, not permanent unavailability

<!-- session 634dc215 2026-10-12 -->
- Deferred tool schemas (ToolSearch) fail to load on demand with "NOT YET KNOWN" — impacts tools like poll-ci, write-doc, code-review, and all mcp__github-wadeck-app__* tools; causes extra round-trips when agent tries to call them blindly.

<!-- session ddaa4cf0 2026-10-11 -->
- Deferred tool schemas consistently fail with "NOT YET KNOWN" (write-doc 08:42:30, mcp__github-wadeck-app__actions_list 08:44-09:53, ToolSearch 08:45:36, agent-browser 09:58:18) — suggests systematic issue with tool schema loading or registration timing.
- Manual CI polling with sleep+actions_list repeated 8+ times (08:44-09:53 range) — poll-ci skill available but unused, wasting context tokens on sleep loops instead of leveraging dedicated polling infrastructure.
- PM2 restart on Infomaniak hangs 5+ minutes consistently despite multiple fix attempts; pm2-jlist reliability is root issue.
- Dependency version strategy (pinned vs latest/*) not documented; switched to latest/* for @wadeck-app packages mid-session after discussion with cap-owner.
- GitHub Actions MCP tools unavailable — `actions_list`, `actions_run_trigger`, `get_job_logs` repeatedly marked "NOT YET KNOWN" throughout session; user had to work around with curl/agent-browser verification instead of native MCP polling
- Heavy reliance on sleep-based polling for GitHub Actions CI/deploy (many `sleep 10/15/20/30/60/100` commands) — no event-driven notification system used; agent manually polled job status every N seconds instead of reacting to completion signals
- MCP tools (actions_list, get_job_logs) repeatedly report "NOT YET KNOWN" after long sleep intervals (90s+) waiting for CI progression. ToolSearch also returned "NOT YET KNOWN" once (17:26:40). Suggests tool schema loading may have timing sensitivity during extended waits—pre-fetch schemas before querying after sleep cycles.

<!-- session 8ae2c774 2026-10-11 -->
- App-core-sdk type exports differ between monorepo and npm package contexts; app-module-queue restructure (views → dsl-frontend → api-backend) suggests folder naming convention wasn't pre-established with app-core team.
- PM2 restart step confirmed stuck for 6+ minutes with multiple retry waits; deploy workflow has reliability issues
- User approval required for global npm package installation (`@wadeck-app/app-core-cli`); not automatic despite trusted workspace
- MCP tool mcp__github-wadeck__actions_list repeatedly shows "NOT YET KNOWN" — calling it to list workflow runs/jobs fails silently or returns unknown status instead of actual CI state
- Session alternates between C:\Workspace_Tooling\queue and C:\Workspace_Other\poc-node without explicit context switching; specs edited in queue but CI/restarts tested in separate poc-node repo
- Deferred tool schemas must be fetched via ToolSearch before calling (GitHub Actions MCP tools, EnterPlanMode/ExitPlanMode, skills like poll-ci and write-doc); "NOT YET KNOWN" warnings indicate first attempt to use them without pre-loading.
- MCP tools for GitHub workflow control (mcp__github-wadeck__actions_list, mcp__github-wadeck__get_job_logs) warn "NOT YET KNOWN" repeatedly; they are deferred but not fetched via ToolSearch before invocation, causing silent tool-call failures.
- Guardrails plugin (w-guardrails/scripts/request-bypass.js) fails with "ReferenceError: checkKillSwitchWrite is not defined" when git-commit bypass is triggered — function is called but never defined, breaking bypass requests.

<!-- session 50367f0a 2026-10-11 -->
- Dependency `@wadeck-app/app-core-sdk` not published on registry; assistant worked around with mirror approach, then had to revert/re-integrate when SDK was finally available. Plan for unpublished/dev dependencies in monorepo workflows.
- PM2 process management in deployment is fragile — agent debugged process name mismatches, timeouts, and stuck restart loops across multiple commits; final fix required workflow restructuring (pm2-jlist replaced).
- Deferred MCP tools must be pre-fetched via ToolSearch before calling; direct invocation without schema load results in validation errors. All three MCP tool families (`mcp__github-wadeck*`, `mcp__intellij*`) are deferred and require explicit ToolSearch calls.
- Deferred tools (MCP actions, GitHub APIs) must be explicitly fetched via ToolSearch before calling, or they silently fail with "NOT YET KNOWN". No auto-load on first call.
- Guardrails plugin `request-bypass.js` has a fatal bug: `ReferenceError: checkKillSwitchWrite is not defined` (appears 3× in error log). Blocks git-bypass attempts throughout session.
- Heavy manual polling pattern: 8+ distinct sleep durations (15s–100s) waiting for CI. Session has `poll-ci` skill available but didn't use it — suggests discovery or preference issue.

<!-- session c67aed0e 2026-10-10 -->
- Non-TTY stdio in Git Bash suppresses CLI output (e.g., `queue --version`); requires `--cli-foreground` flag; this is a shell quirk, not a product regression.
- Pinned-vs-latest dependency policy requires cross-repo coordination: queue, app-core, orchestrator, capability-framework each need independent decision + verification, not a single global change.
- `agent-browser install` is a required one-time setup step before first use; daemon state can become stale across concurrent agent sessions (required `--session` flag to recover).
- Package.json "clean" scripts required in both queue-core and queue-cli after workspace split — default npm workspace cleanup doesn't propagate to package-level dist/.
- GitHub Actions MCP methods (`list_workflow_jobs`, `list_workflow_runs`) return "NOT YET KNOWN" warnings repeatedly — suggests schema loading issue or method naming mismatch with MCP server definition

<!-- session f76d9b35 2026-10-11 -->
- API layout requires api-backend/ + dsl-frontend/ subdirectory structure, not root-level views/ + backend.ts — this layout requirement wasn't obvious from initial contract definitions and required developer clarification via SendMessage.
- agent-browser skill initialization failed silently across multiple attempts ("Browser not launched") — diagnostic exploration (checked bin/, daemon.js, install) didn't conclusively identify root cause (daemon startup? missing binaries? permissions?).
- CI/workflow polling pattern relies entirely on `sleep X && actions_list` loops with highly variable durations (15s–120s). No documented strategy for wait intervals or intelligent event-driven checks.
- Deployment verification window required multiple empirical widenings (120s → 240s+) due to rsync/PM2 restart latency; CI is slow and timing-sensitive, not just sequential.
- Root cause was indirect: ecosystem.config.cjs PM2 config was the issue, but debugging path involved creating test servers, changing bind addresses, adding version endpoints before finding it. Direct config review earlier would have saved iterations.
- agent-browser session management unclear: tried session names queue-test3, queue-test-fresh, queue-check without clear guidance on conflicts or readiness; no error for "browser not ready" or "session collision."

<!-- session a6f2e7c7 2026-10-11 -->
- Deferred tools issued "NOT YET KNOWN" warnings (write-doc skill, GitHub actions tools, agent-browser, ToolSearch) at multiple points, forcing extra diagnostic round-trips instead of immediate availability.
- Infomaniak PM2 deployment (poc-node) stuck for 6+ minutes on restart step, forced manual polling with agent-browser; suggests infrastructure reliability issue or configuration mismatch needing monitoring/alerting.
- Deferred tools (MCP GitHub actions API) require upfront ToolSearch fetch to avoid "NOT YET KNOWN" warning spam; current pattern causes session churn

<!-- session 91f1ee99 2026-10-11 -->
- Dependency availability: @wadeck-app/app-core-sdk was added to queue-app-module before verifying it was published to GitHub Packages; required rollback and rewrite when unavailable. Check registry first when adding @wadeck-app/* scoped dependencies.

<!-- session c240569c 2026-10-11 -->
- @wadeck-app/app-core-sdk wasn't available on registry during initial development, blocking integration. Folder restructure (views → dsl-frontend) had to be coordinated with SDK release timing via cross-team messaging.

<!-- session 580bfde8 2026-10-11 -->
- CI polling used manual sleep + repeated `actions_list` calls; consider using `poll-ci` skill for next push-and-monitor workflow. Dependency publication coordination (app-core-sdk unpublished reference) is a blocker across queue-app-module ↔ app-core.

<!-- session 3867af81 2026-10-11 -->
- Deferred tools (poll-ci, mcp__github-wadeck-app__actions_list, etc.) require explicit ToolSearch call before use; agent must recognize "NOT YET KNOWN" as actionable signal, not continue retrying.

<!-- session 3126a802 2026-10-10 -->
- User explicitly requires TDD on feature work ("je veux que tout soit fait, avec du TDD !"). Project preference to write tests first, then implementation.
- Deferred tool schemas fail with "NOT YET KNOWN" frequently (EnterPlanMode, poll-ci, write-doc, code-review, mcp__github-wadeck-app__* tools) — ToolSearch schema loading is unreliable or tools are not properly registered.

<!-- session 42863e84 2026-10-11 -->
- shared-cli dependency pinning (warnUnknownArgs valueFlags) is a recurring pattern — discovered post-feature commit, required follow-up fix. Dependency verification should be integrated into feature workflow.
- MCP GitHub tools require ToolSearch schema fetch before first use during CI polling; pre-fetch schemas when starting monitoring loops to avoid delayed queries.

<!-- session 8a40edb8 2026-10-11 -->
- CI polling pattern (sleep + mcp__github-wadeck-app__actions_list) used multiple times; multiple "*** NOT YET KNOWN ***" warnings on first MCP calls suggest tool schemas weren't pre-loaded—schema fetching on first use is expected but makes initial queries slower.

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
