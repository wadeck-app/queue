# Project integration

What the Queue module (`app-module-queue`) gives the project module. Routes live under `/api/modules/queue/`.

## `GET /related/project/:projectId`

Card for the project detail page.

```json
{
  "title": "Queue",
  "count": 3,
  "items": [
    { "label": "1 in the dead-letter queue", "url": "/modules/queue/dlq?project=64f4ae91", "subtitle": "count = 2 in flight + 1 given up" },
    { "label": "onPush success", "url": "/modules/queue/history?project=64f4ae91&event=onPush", "subtitle": "5 min ago - sub-a, sub-b +1" }
  ],
  "moreUrl": "/modules/queue/history?project=64f4ae91"
}
```

| Case | Status | Body |
|---|---|---|
| Registered project, virtual project, soft-deleted project | 200 | card (`count: 0`, `items: []` when the queue holds nothing) |
| Id in no registry (live or deleted) | 404 | `{ "error": "No project with id <id> ..." }` |
| Id is not 8 lowercase hex characters | 400 | `{ "error": ... }`, same wording as `/dlq?project=` |
| Unreadable registry or queue file | 500 | `{ "error": ... }` |

- `count` = in-flight WAL entries (pending, or failed and awaiting a retry) + DLQ entries of the project.
- `items` = the 10 newest history entries of the project, newest first, preceded by one DLQ link when the DLQ holds entries of the project. Every `url` starts with `/modules/`.
- Item status in the label, worst first: `dlq`, `failed`, `pending` (fewer dispatches reported than matched), `success`, `filtered`; `orphan` for a record with no trigger.
- A retry has its own history record: it shows as a separate `orphan` row, it is not merged into the original.
- Subscriber ids in a subtitle can carry another project's prefix (a `to-children` event also runs the descendants' subscribers).

### Attribution: which dispatches belong to a project

Count and items cover the dispatches filed under the project (WAL/DLQ `meta.projectId`; history `projectId` of the push, or of a subscriber outcome).

| Push direction | Filed under |
|---|---|
| default (the project only) | the emitter |
| `to-parents` | the emitter |
| `to-children` | each descendant whose subscriber ran; the emitter's own subscribers stay under the emitter |

So the emitter of a `to-children` event does not see the dispatches that ran in its descendants; each descendant does.

## Slot `queue:project-header`

Declared in `manifest.json` (`expose.slots["project-header"]`). Accepted root `$type`s: `Badge`, `Link`, `ButtonLink`.

The History and DLQ pages embed it (`ExtensionSlot`) when `?project=<id>` names a known project, so a contributor adds a link back to that project. Shown only with a known project; it renders nothing when no module contributes.

The page reads the project through `GET /project-scope?project=<id>`:

```json
{ "id": "64f4ae91", "name": "app", "found": true }
```

`found` is `false` (status 200) for a missing, repeated, malformed or unregistered id: a header must not break the page. A soft-deleted project is found. An unreadable registry answers 500.

A contributor needs `requires: { "queue": "*" }` and a root of an accepted type; it builds its own href (`/modules/project/p/<id>`). Whether a contributed node can read `$sources.projectScope` is not verified.

The Subscribers page does not embed the slot yet: it filters on `?cwd=`, not on a project.
