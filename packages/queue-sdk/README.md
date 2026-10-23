# @wadeck-app/queue-sdk

Push events to the queue daemon from any Node program. It finds the daemon, authenticates, starts it on demand, checks that SDK and daemon speak compatible protocols, and reports every failure instead of swallowing it. Zero runtime dependencies, Node >= 22, ESM and CommonJS, Windows / macOS / Linux.

```ts
import { createQueuePublisher } from '@wadeck-app/queue-sdk';

const queue = createQueuePublisher();

queue.publish('myapp.job_done', { jobId: 'nightly', ok: true });   // fire and forget, never throws

const result = await queue.publishAndWait('myapp.job_done', { jobId: 'nightly' });
// { status: 'queued', eventId: '...' }, or { status: 'dropped', reason: '...what to do...' }

await queue.flush();   // before process.exit(): waits for the pushes in flight
```

## Install

Published on GitHub Packages like `queue-cli`: map the scope once, then install.

```
# ~/.npmrc or the project's .npmrc (the token needs read:packages)
@wadeck-app:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=<token>
```

`npm install @wadeck-app/queue-sdk`. The `queue` CLI must be installed on the machine: the SDK runs `queue start` when the daemon is stopped (it stops itself after about a minute of inactivity). The SDK only looks for the `queue` executable on `PATH`; it does not depend on `queue-cli`.

## What you get

| Call | Result |
|---|---|
| `publish(event, payload)` | `void`; never throws |
| `publishAndWait(event, payload)` | `{ status: 'queued' \| 'dispatched' \| 'dropped' \| 'unknown', eventId?, result?, reason? }`; never rejects |
| `flush()` | Resolves when every push in flight has settled |
| `status()` | How the daemon would be reached; sends nothing, starts nothing |

`unknown` means the connection broke or timed out after sending: the event may be recorded and is never retried (check `queue history`). Events named `before*` are synchronous: the call waits for the subscribers.

Nothing throws. Every failure goes to your `onError` callback and, unless `silent`, to `console.warn` once per problem, with what happened and what to do.

## Documentation

- [Reference](docs/reference.md): options, methods, results, how the daemon is reached, versioning.
- [Troubleshooting](docs/troubleshooting.md): every failure kind, its cause and the fix.
- [Push protocol](https://github.com/wadeck-app/queue/blob/main/docs/push-protocol.md): the wire contract, for clients in other languages.
- Contributors: [guiding-principles.md](guiding-principles.md) and [out-of-scope.md](out-of-scope.md).
