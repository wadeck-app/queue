# Subscriber `type: action` (outbound plugins)

First consumer: w-agent-wake, whose whole contract is one queue event `agent.message { to, text, from?, mode? }`. Today's glue is a cli subscriber running an external script.

## Decision

Option A: a new subscriber type `action` run in-process by the daemon through an `ActionPlugin` registry (the outbound counterpart of `RelayPlugin`). Rejected: B (`queue notify agent` as a cli command: `queue` is a `.cmd` shim on Windows, so real agent text hits the cmd-metacharacter refusal), C (a robust external script: queue would have to know where Claude Code installs plugins).

| Piece | Where |
|---|---|
| `ActionPlugin`, `ActionContext`, `ActionRegistry` (an instance, not a global map) | `queue-core/src/actions/` |
| `emit` action: renders `with.payload`, pushes `with.event` | `queue-core` (generic, knows nothing about agents) |
| `agent-wake` action: a strict preset over `emit` (fixed event, validated `to`/`text`/`from`/`mode`) | new package `plugin-agent-wake`, registered from `queue-cli/src/actions/builtinActions.ts` |
| Schema | `type: cli|http|action`, `action`, `with` in `SubscriberConfigSchema`; same in `ResolvedSubscriber` |
| Dispatch | `ActionTransport` returning `DispatchResult`; one shared `runSubscriber` switch replaces the duplicated cli/http branches of the two dispatchers; `target` printed as `action:<name>` |

## Rules

1. **Templates** (`with` values): rendered in Node, never in a shell. `{{ payload.x }}` (nested paths allowed for actions, own properties only), `{{ event }}`, `{{ id }}`, `{{ timestamp }}` are envelope fields. A bare `{{ x }}` is a load-time error ("write `payload.x`"): cli semantics stay untouched. Single pass; objects as JSON; NUL refused; each rendered field capped (64 KB).
2. **Load-time validation**: unknown action (lists the available ones), `with` checked by the plugin's strict schema (no silent stripping), `command`/`url`/`headers` refused on an action, placeholder syntax and scope, cycle check.
3. **Runtime failures** (render or validation after substitution): `permanent: true`, straight to the DLQ with a message naming the subscriber and field.
4. **Loops**: static cycle check at config load (the plugin declares `emits(config)`; graph over the merged patterns with `EventMatcher`), plus a runtime `meta.hops` counter set only by the internal push (never from the wire), cap 5. Emitting an event starting with `before` is refused.
5. **Attribution**: the emitted event is pushed with the source envelope's `cwd`/`projectId` (a virtual project passes `project`). Direction: the default.
6. **Prompt injection** (new threat, goes into `threat-model.md`): untrusted webhook text becomes agent input. `to` is a literal or constrained to the id pattern (a payload must not choose the recipient session); `mode: passive` recommended for untrusted sources; `from` is a literal such as `queue:<event>`; `text` capped.
7. **Protocol**: unchanged (`/push`, `/register-events`); only the `subscribers.yml` schema grows. An older daemon rejects a file with `type: action` loudly (`aborted` with the reason).
8. **Delivery is at-least-once**: the consumer must tolerate a duplicate `agent.message`.
9. **Catalog**: w-agent-wake declares `agent.message` itself through `register-events`; the plugin's `emits` lets `queue sub add` warn when the emitted event is undeclared.

## Steps

1. queue-core contract + registry + `renderActionTemplate` + `emit`, with tests.
2. Schema/types + `assertDispatchable` branch + cycle check + `meta.hops`.
3. `ActionTransport` + shared dispatcher switch + `target` helper; `QueueService` wiring (lazy `push`).
4. CLI: `--type action --action <name> --set k=v` (plugin shortcut flags only if the plugin lists its fields), pre-checks in `sub add|edit`, listings.
5. `plugin-agent-wake` package + registration (CLI, daemon, app-module), root scripts, CLAUDE.md.
6. Tests: unit, dispatcher (permanent to the DLQ on the first attempt), `QueueService` (attribution, hop cap, `before*`), daemon integration with `createIsolatedCliEnv`, a file with action entries survives `queue sub edit` of a neighbour.
7. Docs: `docs/subscribers.md` section, threat model, CLAUDE.md.

## Amendments after review (override the text above where they conflict)

| # | Amendment |
|---|---|
| P0.1 | No graph check inside `ConfigLoader.load()` (it runs on every push/retry/list, one cycle would abort unrelated events and `queue sub list`). A separate pure `findActionCycles(subscribers)`: edges only along the real delivery chain (emitter layer chain in the default direction + global); an error only when no edge of the cycle has a `when:`, otherwise a warning; called by `queue sub add\|edit` and as a daemon log line, never an abort. `with.event` must be a literal concrete name (no placeholder, no `*`/`>`). The runtime hop cap is the real guard. |
| P0.2 | `SyncDispatcher` JSON-parses stdout: `ActionTransport` returns an EMPTY stdout on success (any trace goes in a separate `detail` logged by the dispatcher). An action on a `before*` pattern only passes through (documented). |
| P0.3 | `{{ id }}`/`{{ timestamp }}` are unstable across retry/dlq-replay (WAL id, new Date). Store the original event id in `meta.eventId` at the first push; `{{ id }}` renders `meta.eventId ?? envelope.id`, so the `ref` default is a stable dedupe key. |
| P0.4 | The dispatchers use `if cli ... else http` (an action would fall into http): shared `runSubscriber` switch with a `never` exhaustiveness check + a test proving an action never reaches HttpTransport. |
| P0.5 | `new ConfigLoader(dir, { actions? })`. With a registry: strict validation (unknown action, `with` schema). Without (app-module list, `queue sub list`): structural validation only. `emit` is pre-registered in queue-core's default registry. The app module never imports queue-cli or the plugin. |
| P0.6 | An unknown action name must not abort the whole file: that subscriber gets a `configProblem` and fails alone, permanently, to the DLQ with a loud message; `sub add\|edit` refuse it. This pulls the old Q5 in scope: `failConfig` must end in the DLQ, not leave the WAL entry `failed` forever. |
| P1 | Every site that reads `command ?? url` or switches on type must handle `action` (list-subscribers, sub list, sub list --scope entry shape, usage texts, ConfigLoader toResolved `method: 'POST'`, dispatcher `target`, subscribers-page.yaml columns). Mask `with` values in the dashboard route (tokens). Refuse or ignore explicitly `method`, `cwd`, `env`, `headers`, `command`, `url` on an action. `timeout` honoured with Promise.race + try/catch (a plugin throw is retryable, not permanent). `DispatchResult` moves to a shared module. |
| P2 | Internal `pushInternal(req, { hops })` extracted from `commands.push` (hops never in `PushRequest`, never from the wire); cap check at emit time (`source.hops >= 5` is a permanent failure), `meta.hops + 1` on the emitted event; meta survives WAL/DLQ/retry/dlq-replay, `queue replay` resets the counter (documented). Total emitted payload capped (64 KB), `before*` refused with `startsWith('before')`. Attribution: the project of the envelope the subscriber received (descendant for `to-children`), plus `causedBy` provenance in the trigger record. |
| P3 | Action templates do not reuse `findTemplateProblem` (cli-only hazards). Unquoted `text: {{ x }}` parses as a YAML flow mapping: docs note. `--set k=v` repeatable, split on the first `=`. `with` is `z.record(z.unknown())`. |
| Order | 1 contract (new files) → 2 schema/types lenient + inert → 3 dispatch + failConfig → 4 QueueService wiring + hops → 5 findActionCycles → 6 listings/dashboard → 7 CLI authoring → 8 daemon registration + integration → 9 plugin-agent-wake → 10 docs. Each step leaves the tree green. |

## Decisions (answered by claude-owner)

| # | Question | Answer |
|---|---|---|
| 1 | Preset validating `to`/`mode` | Ship `emit` and the `agent-wake` preset |
| 2 | Attribution of the emitted event | The source envelope's project, default direction. `queue wait` does not filter by project (waitCli.ts reads by event name and time only): add a test |
| 3 | Placeholder in `to` | Allowed when the rendered value is a UUID or `project:` + 1-200 characters without control characters or line breaks (spaces, parentheses, accents allowed) |
| 4 | Who declares `agent.message` | The emitter: `plugin-agent-wake` through `emits` / register-events. Catalog text: `agent.message { to, text, from?, mode?, ref? }: wake an idle Claude Code session (to = session id or project:<folder>)` |
| 5 | `failConfig` (a misconfigured subscriber stays `failed`, never reaches the DLQ) | Out of this change, separate fix |
| 6 | Idempotence: a replayed or retried action pushes a new event id | Contract adds `ref` (optional string, cap 200); the preset defaults `ref` to the source `{{ id }}` so the consumer can ignore a duplicate |
