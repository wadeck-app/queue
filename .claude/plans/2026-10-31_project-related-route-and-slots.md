# Project integration: `related/project/:projectId` + `queue:project-header` slot

Requested by project-owner (module `project`, project detail page `/modules/project/p/:project`). Contract is theirs to adapt; their answers override the first draft.

## Contract decisions (agreed with project-owner)

| Case | Answer |
|---|---|
| valid id in registry (live) | 200 with real data |
| virtual project | 200 with real data (count 0, `items: []` when empty), never 404/500 |
| soft-deleted project | 200 with its data (name via `findProjectIncludingDeleted`) |
| id not in registry (live or deleted) | 404 with `{ error }` naming the id |
| malformed id (not 8 hex) | 400 `{ error }`, same wording as `/dlq` |
| corrupt registry | 500 (loud) |

Response: `{ title: "Queue", count, items: [{label, url, subtitle?}], moreUrl }`. All urls start with `/modules/`.

## Route `GET /related/project/:projectId` (app-module-queue)

1. New `src/backend/related.ts` (`getRelatedForProject(configDir, registryDir, projectId, now?)`) + `related.test.ts`; register in `src/backend/index.ts` and in the route list asserted in `backend.test.ts`.
2. Registry read per request (as `/projects`, `/subscribers`).
3. `count` = in-flight WAL entries of the project (pending + failed awaiting retry, what the pending page shows) + DLQ entries of the project. Not `readQueueCounts` (pending only). Subtitle states what is counted.
4. `items` = latest 10 history entries of the project via `HistoryReader` directly (no `payloadText`). Include entries matched through `subscribers[].projectId`, as the history filter does.
   - label = `<event> <status>`; status worst-wins: dlq, failed, success, filtered; `pending` when matched > outcomes; `orphan` when orphan.
   - subtitle = time + subscriber ids (`+N` beyond 2).
   - url = `/modules/queue/history?project=<id>&event=<name>`; when DLQ count > 0 add a leading item linking `/modules/queue/dlq?project=<id>`.
   - `moreUrl` = `/modules/queue/history?project=<id>`.
5. Subscriber count: skipped in this iteration (the shape has no free field; the subscribers page has no project mode yet).
6. Budget 2 s: history/WAL/DLQ are read in full per request; measure on a large history and, if needed, bound by date or share a module-level reader (mtime cache).

## Slot `queue:project-header`

1. `manifest.json`: `expose.slots["project-header"]` with `accepts` limited to link-like roots (verify the exact `$type`s that exist; `Badge` with `href` is used by `relay-badge.yaml`). Final ids and `$type`s are sent to project-owner after review.
2. Embedded on the history and DLQ pages (the two views that already take `?project=`). Subscribers page: deferred (it takes `?cwd=`, not a project); requires `GET /subscribers?project=` first. Tell the peer.
3. A contributed node cannot read the query param (`$route` = path params only in the bundled shell, unverified for the peer's app-core). Host exposes it: new route `GET /project-scope?project=<id>` returns `{ id, name, found }` (registry incl. deleted); host source `projectScope` (params `project: $urlParam.project`); contributed nodes read `$sources.projectScope.id|name`; the slot is shown with `$if: $sources.projectScope.found`.
4. Unverified, to confirm with `app-core-cli dev` and the peer: how a contributed node builds `/modules/project/p/<id>` from `$sources.projectScope.id` (string templating on a non-row component); fallback = peer supplies the href expression.

## Tests

- `related.test.ts` (temp dirs, real files): counts (WAL pending, failed, DLQ of another project not counted), 10 newest first, match via `subscribers[].projectId`, urls prefix, virtual project, deleted project, unknown id 404, malformed 400, corrupt registry 500, empty history.
- `project-scope`: found / deleted / unknown / empty param.
- `backend.test.ts` routes; view tests for the `ExtensionSlot` in history and DLQ pages; `npm run check` validates `expose`.

## Docs

Root `CLAUDE.md` (route list + exposed slot), `README.md` if it lists routes, a short contract section for the provider route.

## Amendments after review

| # | Amendment |
|---|---|
| R1 | Scope of count/items = dispatches filed under the project (WAL/DLQ `meta.projectId`, history `projectId` or `subscribers[].projectId`). A `to-children` dispatch is filed under the descendant, a `to-parents` one under the emitter: document it and tell project-owner; tests with `emitterProjectId`. |
| R2 | Status: pending = matchedCount - non-filtered outcomes > 0, counting only outcomes of this project; retry outcomes show as separate orphan rows (documented, not merged). Subtitle subscriber ids may carry another project's prefix. |
| R3 | `HistoryReader` parses every day file per request: measure on a large history; if the 2 s budget is at risk add a project-aware pruned read, not an unbounded module-level cache. |
| R4 | `project-scope`: malformed/empty/unknown id gives `found:false` (a header must not break the page); corrupt registry stays 500. Queue returns `{id,name,found}` only and the peer builds its own href, unless templating is confirmed. Verify in `app-core-cli dev`: `/api/slots/queue:project-header` with no contributor returns [], and a failing slot fetch does not break the page. |
| R5 | `backend.test.ts` asserts the ordered route list and mocks each module: add both routes at the same position plus `vi.mock` for `related.js` and `projectScope.js`. Route params need app-core >= 2026.10.17-023. Reuse one malformed-id helper (wording of /dlq). |
| R6 | Add tests: `dlqPage.test.ts` (none exists), manifest `expose.slots`, real-server 404-with-body, >10 entries, ts ties, orphans, missing registry (404 for every id; virtual project 200). |
| R7 | The CalVer `requires` blocker is closed by project-owner (`requires: {x: "*"}` works for CalVer providers). |

## Out of scope / later

Subscribers page slot and `GET /subscribers?project=`; subscriber count in the card; deep link to a single `eventId` (history page has no such param).
