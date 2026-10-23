# queue-sdk: out of scope

What the SDK deliberately does not do. A request for one of these is a decision for the queue owner, not a small change.

| Not done | Why | Instead |
|---|---|---|
| Start the daemon without the CLI | The only code that knows how to launch the daemon is `queue-cli`; embedding it would couple the SDK to it | `queue start` is run when `queue` is on `PATH` |
| Keep events when the daemon cannot be reached or started | A spool file replayed by the daemon changes the daemon's architecture | The event is reported as `dropped` with the reason |
| Subscribe to or read events, history, the DLQ or the WAL | Reading is `queue-core` and `app-module-queue` territory | `queue wait`, `queue history`, the dashboard |
| Change `subscribers.yml`, start or stop the daemon or the relay | Routes that change what runs are a security decision (`.claude/threat-model.md`) | The CLI, by a person |
| Idempotency keys or exactly-once delivery | Not in protocol 1; a reset after sending leaves the outcome `unknown` | Check `queue history` before sending again; an optional field can be added in a MINOR |
| Retries with backoff, queues that survive the process | The SDK is a thin client; the daemon owns delivery to subscribers | `await queue.flush()` before exiting |
| Event-name conventions or schemas | The queue does not know your events | Suggested form: `<source>.<verb>` such as `job.started` |
| Remote daemons, TLS, other hosts | The daemon binds `127.0.0.1` only | |
| Clients in other languages | The contract is `docs/push-protocol.md` in the repository | Implement the contract |
| Browsers | Node >= 22 only (files, `child_process`) | |
