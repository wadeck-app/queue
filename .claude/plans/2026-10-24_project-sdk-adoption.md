# Adopting project-sdk: the project of an event comes from the registry

Status: proposal agreed with project-owner (Q31), not confirmed by the user. Nothing implemented. `@wadeck-app/project-sdk@2026.10.24-002-ce51c7da` is published (depend on `latest`); the `project` binary is not, so files are moved by hand later.

## Today

- `ConfigLoader.findProjectFile(cwd)` walks up at most 20 levels to the first `.queue/subscribers.yml`; `resolveProjectName(cwd)` walks up to the first `.queue` folder and returns its basename.
- The project name is a folder name: two checkouts called `app` collide, a rename changes the name stored in history.

## Target

| Concern | Rule |
|---|---|
| Project of an event | `findProjectForPath(loadRegistry(defaultRegistryDir(env)), cwd)`; deepest registered path wins |
| Project subscribers | `projectToolDir(registryDir, id, 'queue', 'config')/subscribers.yml`; inherited layers via `getConfigLayers` + `mergeLayers` (parents first, own last) |
| Project name in history, DLQ, dashboard | the project name from the registry; the id is the scope of a subscriber id (`<project id>/<name>` replaces `<project name>/<name>` of the subscriber-names plan) |
| Selection on the CLI | `--project` > `QUEUE_PROJECT` > cwd (`resolveScope`) |
| Dashboard module | no cwd: `resolveReference` then `mainPath` |

## Not silent

- A cwd outside every registered project: global subscribers fire, plus a warning in the daemon log and in the `queue push` output naming the cwd and the exact `project add "<cwd>"` command. The push does not fail.
- A `.queue/subscribers.yml` found by the old walk-up while the registry knows no project for that cwd: it still fires, and every use logs "legacy .queue/subscribers.yml used for <file>: move it to <config dir> (project add)".

## Transition and removal condition of the walk-up

The walk-up exists only until the files have been moved by hand (no migration code, project-owner Decision #17). It is removed in the first release after both hold: the `project` binary is published, and `queue sub list` over the user's registered projects reports no legacy file. Until then it is the fallback of last resort, never the first lookup: registry first, walk-up second.

## Steps (each starts with a failing test)

1. Registry lookup behind a seam in queue-core (`ProjectResolver` taking the registry dir), tests isolated with `XDG_CONFIG_HOME` / `HOME` / `USERPROFILE` in a temp dir, never the real `~/.config/project`.
2. `ConfigLoader` takes the resolver: registry project first, walk-up fallback with the warning above.
3. Outside-every-project warning in the daemon log and `queue push` output (push protocol unchanged: a warning field would be additive, 1.x; decide at implementation).
4. `--project` / `QUEUE_PROJECT` on `queue sub`, `queue history`, `queue replay`.
5. Subscriber-names step 1 uses the project id as scope (do the name work first with the folder name, then switch; one change at a time).
6. Dashboard: project column shows the registry name; the module resolves by reference.
7. Removal of the walk-up once the condition above holds.

## Explicit project on a push (agreed with project-owner)

- `queue push ... --project B` (short `-p`, accepted anywhere), env `QUEUE_PROJECT` between the flag and the cwd.
- The caller (CLI, queue-sdk) resolves the reference (id, name or alias) and sends the project id plus the cwd: the registered path of that project containing the caller's cwd, else its `main`. A virtual project has no path: the push fails with the SDK's `VirtualProjectError`, no event without cwd.
- The daemon trusts ids only and validates them against its own registry read; unknown id = `rejected` with the fix. Without an explicit project it derives the project from the push cwd (`findProjectForPath`).
- Protocol: an optional `project` field in the push body is additive, so MINOR 1.2.0 (contract fixture and `docs/push-protocol.md` in the same commit). queue-sdk then depends on project-sdk only if it resolves references itself; to keep it zero-dependency it takes the id as an option and the CLI does the resolution (decide at implementation).

## Open

- History written before the switch keeps its folder-name project; no rewrite.
