# queue-sdk: guiding principles

Rules a contributor keeps. If a change breaks one, the rule and the change are discussed first.

## Behaviour

- **Never throw, never block the caller.** `publish` returns `void`, `publishAndWait` always resolves. Failure is a value (`dropped`, `unknown`) plus a report.
- **Never fail silently.** Every failure reaches `onError` and, unless `silent`, the console, with what happened and what to do. Default output is deduplicated per problem until a push succeeds; `onError` is not.
- **No duplicate events.** Retry only when nothing can have been recorded: 401 (auth runs before the handler), refused connection, no daemon. A reset or a timeout after sending is `unknown` and is not retried.
- **Never send the token to an unverified process.** `GET /version` must return the pid of `config.port` and the same config directory first. The token never appears in a message or a log.
- **The payload only travels over HTTP.** The only thing ever put on a command line is the constant `start`; the config directory goes through `QUEUE_CONFIG_DIR` in the environment.
- **Bounded.** `maxPending` caps the work in flight; the overflow is dropped and reported.

## Design

- **Zero runtime dependencies**, and no dependency on `queue-cli` or `queue-core`, not even in development. The SDK only looks for the `queue` executable on `PATH`. `queue-core` depends on the SDK (`./protocol`), never the reverse.
- **One source of truth for the protocol.** Constants and the SemVer helper live in `src/protocol.ts` and `src/semver.ts`; the daemon imports them from `@wadeck-app/queue-sdk/protocol`. Nothing is copied.
- **Small public surface.** `src/index.ts` is the whole API; everything else is internal. Adding an export needs a reason in the README.
- **Trust nothing read from the daemon.** Unknown fields are ignored, an unknown `status` is a failure, a malformed answer is a failure with an excerpt.
- **Windows, macOS and Linux.** No POSIX-only call, no hard-coded separator, no `which`. Platform-specific tests are skipped with `describe.skipIf` and the reason in the title, never silently. CI runs the suite on all three.

## Protocol changes

The push protocol has its own SemVer version (`docs/push-protocol.md` in the repository).

| Change | Bump |
|---|---|
| Remove or rename a field, change a meaning, add a required request field | MAJOR |
| Add an optional field or a documented status value | MINOR |
| Wording only | PATCH |

- A MAJOR keeps the previous MAJOR in the daemon's `accepts` range for at least one release cycle.
- Every change updates `contract/protocol-<major>.json`; `queue-core` replays it against the real service and the SDK against its parser.
- Change the constants, the fixture and `docs/push-protocol.md` in the same commit.

## Method

- **TDD.** Write the test, watch it fail for the right reason, make it pass, refactor. Tests that need the outside world use the injected seams (`createQueuePublisherWithDeps`) or a real local fake daemon on `127.0.0.1` port 0; they never touch the user's real daemon, and never run the real `queue start`.
- **Messages are part of the contract.** A test asserts what a failure message tells the user to do.
- **Source style.** ASCII only, English, comments above the line, braces on every `if`, `getErrorMessage` from `src/errors.ts` instead of reading `error.message` inline.
