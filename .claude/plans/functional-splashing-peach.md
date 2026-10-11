# Split `queue` into npm-workspace packages (queue-core / queue-cli)

## Context

`queue` is currently one package (`src/cli`, `src/daemon`, `src/storage`, `src/dispatch`, `ConfigLoader.ts`, `types.ts`, `errors.ts`). The goal (per discussion with `app-core-owner`) is to prepare a future `queue-app-module` for `app-core`'s plugin dashboard. That future module will need queue's daemon/storage logic (to read history, trigger replay, etc.) as a library, without depending on queue's CLI argument-parsing or its Go-launcher/esbuild bundling pipeline.

`orchestrator` already solves this with npm workspaces under `packages/*`. Verified directly against `orchestrator`'s actual working CI (not just the simpler `orch-app`/`orch-ui` packages) that `packages/orchestrator-cli` is published *directly* (no separate "-dist" wrapper), and its CI scripts (`bundle.ts`, `generate-platform-packages.sh`) use paths relative to their own script location, so they work unmodified regardless of nesting depth, and the generated ephemeral platform packages are written straight into the repo-root `packages/` dir *during the CI job only* alongside the real source packages — never committed, never colliding with `npm install`'s workspace discovery (they don't exist yet at install time).

This plan does **not** touch the live-data app-module work itself (still future, separate repo). It only prepares `queue`'s own repo structure. `queue`'s existing dist-wrapper publish mechanism (`generate_dist()` → `packages/queue-cli-dist`) is kept as-is — rewriting it to match orchestrator-cli's newer "publish the source package directly" pattern is a separate, independent cleanup not required for this goal, and touching the production publish pipeline more than necessary adds risk for no benefit here.

## Target layout

```
queue/
  package.json              # root workspace: "workspaces": ["packages/*"], no deps of its own
  packages/
    queue-core/
      package.json          # name: @wadeck-app/queue-core, private: true (not published yet --
                             # flip when queue-app-module actually needs it from the registry)
      tsconfig.json
      vitest.config.ts
      src/
        ConfigLoader.ts(.test.ts)
        types.ts
        errors.ts
        storage/            # Wal, DlqStore, EventLogger, HistoryLog (+ tests)
        dispatch/           # AsyncDispatcher, SyncDispatcher, CliTransport, HttpTransport,
                             # EventMatcher, OutputCapture, PayloadFilter, RetryScheduler (+ tests)
        daemon/
          QueueDaemon.ts     # the daemon logic only -- NOT daemon-entry.ts
        index.ts             # barrel: re-exports exactly what queue-cli needs (see below)
    queue-cli/
      package.json          # name: queue-cli (unscoped -- avoids colliding with the CI-generated
                             # published name "@wadeck-app/queue-cli" from generate_dist()),
                             # private: true, depends on "@wadeck-app/queue-core": "*"
      tsconfig.json
      vitest.config.ts
      bin/                  # (still CI-generated at publish time, unchanged)
      ci/                   # moved as-is from root ci/ -- scripts are __dirname-relative, so
                             # bundle.ts's `rootDir = join(__dirname, '../..')` still resolves to
                             # packages/queue-cli/ (its new "root") with zero code changes needed
      src/
        cli/                 # QueueIndex.ts, QueueClient.ts, LogFormatter.ts, HistoryReader.ts,
                              # HistoryFormatter.ts, HistoryFollower.ts, queue-updater-entry.ts (+tests)
        daemon/
          daemon-entry.ts     # imports startDaemon from "@wadeck-app/queue-core"
```

## Package boundary (verified via grep, not guessed)

The only cross-boundary imports today from `src/cli/*` and `src/daemon/daemon-entry.ts` into the code that's moving to `queue-core` are:
- `getErrorMessage` from `errors.ts`
- `QueueCommands` type from `daemon/QueueDaemon.ts`
- `SubscriberConfig`, `SubscribersYmlSchema` from `ConfigLoader.ts`
- `startDaemon` from `daemon/QueueDaemon.ts`
- `EventLogger` from `storage/EventLogger.ts`

`queue-core/src/index.ts` re-exports exactly these five. Everything else `queue-core` contains is internal to it. `HistoryReader`/`HistoryFormatter`/`HistoryFollower` already have zero dependency on `storage/HistoryLog` (confirmed by grep) — they independently know the NDJSON field shape for *reading*; that's existing design, unchanged.

## Steps

1. **Root `package.json`**: replace with a workspace root (`"private": true`, `"workspaces": ["packages/*"]`, scripts: `build`/`test` chain `--workspace=packages/queue-core` then `--workspace=packages/queue-cli` explicitly. This is necessary (not a style choice) because queue-cli's esbuild bundle step needs queue-core's compiled `dist/` already on disk, and npm's `--workspaces` wildcard does not guarantee topological order — unlike orchestrator, which can use the plain wildcard because none of its workspace packages build-depend on each other's compiled output today. (Reviewed alternative: add `"references": [{ "path": "../queue-core" }]` to `packages/queue-cli/tsconfig.json` so `tsc --build` orders itself automatically, independent of root-script sequencing — worth adding alongside the explicit chaining as a safety net, not instead of it.)

2. **`packages/queue-core/`**: `git mv` the listed files into `src/` preserving subpaths. New `package.json` (main `./dist/index.js`, types `./dist/index.d.ts`, `build`: `tsc --build tsconfig.json`, `test`: `vitest run`, deps: `js-yaml`, `jsonpath-plus`, `zod`, `@wadeck-app/singleton-daemon-kit` — the last one because `QueueDaemon.ts` calls `createDaemon` from it). New `tsconfig.json` copied from root's (composite, rootDir `src`, outDir `dist`), new `vitest.config.ts` copied from root's. Update internal relative imports only where the move changes relative depth (same subpath structure, so most imports between e.g. `daemon/QueueDaemon.ts` and `storage/Wal.ts` don't change at all).

3. **`packages/queue-cli/`**: `git mv` `src/cli/`, `src/daemon/daemon-entry.ts`, `ci/` (this already contains `launcher-queue.config.json` and `templates/` — nothing extra to move separately) into it. New `package.json` (today's root package.json content, minus the moved-out deps, plus `"@wadeck-app/queue-core": "*"`). **Keep `@wadeck-app/singleton-daemon-kit` here too** — `QueueClient.ts` calls `createDaemonClient` from it, and `ci/scripts/build-launcher.mjs` does `require.resolve('@wadeck-app/singleton-daemon-kit/package.json')` to locate the Go launcher SDK; both packages depend on it independently, it does not move "out" of queue-cli. Copy root `tsconfig.json`/`vitest.config.ts` in. Fix the 5 cross-boundary imports (above) to `from '@wadeck-app/queue-core'` instead of relative paths.

3a. **Fix `ci/scripts/copy-binaries.sh`'s source paths** (the one script that is *not* `__dirname`-relative, unlike `bundle.ts` and `build-launcher.mjs` which resolve correctly on their own after the move). It currently reads bare, CWD-relative `launcher-go/dist/...` and `dist-bundle/...`. After the move those artifacts land under `packages/queue-cli/launcher-go/dist/...` and `packages/queue-cli/dist-bundle/...` (confirmed: `build-launcher.mjs`'s `PACKAGE_DIR = __dirname/../..` and `bundle.ts`'s `rootDir` both resolve there once nested), while the script still runs with CWD = repo root. Update its two source variables to the `packages/queue-cli/...`-prefixed paths; its destination paths (`packages/queue-cli-win32-x64/...` etc.) are unaffected since those stay repo-root-relative.

4. **`.gitignore`**: remove the blanket `packages/` ignore (comment said "generated by CI" — no longer true, `packages/*` now holds real source). Add targeted ignores instead for what CI still generates at publish time: `packages/queue-cli-dist/`, `packages/queue-cli-win32-x64/`, `packages/queue-cli-darwin-*/`.

5. **`.violations/config.ts`**: remove `'packages/**'` from `globalExclude` (same reasoning as .gitignore) — matches orchestrator's root config, which excludes specific generated sub-paths, not all of `packages/`.

6. **`.github/workflows/publish-queue-cli.yml`**: 
   - `Build TypeScript` step: unchanged command (`npm run build`), now resolves to the new chained root script.
   - `Run tests` step: unchanged command (`npm test`), now resolves to the chained root script.
   - `Build Go launchers` step: `npm run build-launcher` → add a thin root script `"build-launcher": "npm run build-launcher --workspace=packages/queue-cli"` (script body itself, `ci/scripts/build-launcher.mjs`, is unmodified, just now lives under `packages/queue-cli/ci/scripts/`).
   - `Bundle` step: `npm run bundle` → `"bundle": "npm run bundle --workspace=packages/queue-cli"` at root, same env var passthrough (`BUNDLE_VERSION`).
   - `Generate platform package directories` / `Copy artifacts to platform packages` steps: update the two `bash ci/scripts/...` invocations to `bash packages/queue-cli/ci/scripts/...` (full path from repo root, matching orchestrator's exact pattern — confirmed this is how orchestrator's workflow invokes its own nested scripts).
   - `Set version in all packages` / `Publish platform packages` / `Publish main package`: unchanged — they already operate on `packages/queue-cli-dist`, `packages/queue-cli-win32-x64`, etc., which are still generated at the repo-root `packages/` dir exactly as today.

7. **Fix the ~30 test/source files' relative imports** broken by the move (anything crossing from `src/cli/*` to the old root-level `storage/dispatch/ConfigLoader/types/errors` — only the 5 listed above, each a 1-line import change).

8. **Regenerate `package-lock.json`** by running `npm install` at root after the restructure, and commit the result — switching to `"workspaces": ["packages/*"]` substantially changes its shape. CI uses `npm install --prefer-offline` (not `npm ci`), so a stale lockfile wouldn't hard-fail the pipeline, but it would drift silently otherwise.

9. **Dev ergonomics note**: a bare `npm test` on a fresh clone (no prior `npm run build`) will fail to resolve `@wadeck-app/queue-core` from queue-cli's tests, since the workspace symlink points at queue-core's *compiled* `dist/`, not its source. CI is fine (the workflow always runs `npm run build` before `npm test`), but add a one-line note to this effect in CLAUDE.md so a contributor isn't confused locally.

## Verification

- `npm install` at root (workspace symlinks created for `@wadeck-app/queue-core` inside `packages/queue-cli/node_modules`).
- `npm run build` at root → both packages compile in order, no TS errors.
- `npm test` at root → full suite (167 tests) passes, same count as before the split.
- `npm run bundle --workspace=packages/queue-cli` with a dummy `BUNDLE_VERSION` → produces `packages/queue-cli/dist-bundle/queue.cjs` etc., confirming esbuild correctly resolves `@wadeck-app/queue-core` through the workspace symlink into the compiled dist.
- Smoke-test the bundled CLI directly (`node packages/queue-cli/dist-bundle/queue.cjs --version`) before touching CI, so a bundling mistake is caught locally.
- Push to a branch (not `main`) first if possible, or push directly and watch CI closely (per established workflow in this project) since `main` triggers `CI / Publish` — confirm `build-and-test` AND `publish` jobs both go green, then `queue cli update` + a live `queue push`/`queue history`/`queue replay` smoke test exactly like after every other change in this project.
