import type { EventEnvelope, ResolvedSubscriber } from '../types.js';
import type { ActionTransport } from './ActionTransport.js';
import type { CliTransport } from './CliTransport.js';
import type { DispatchResult } from './DispatchResult.js';
import type { HttpTransport } from './HttpTransport.js';

export interface Transports {
  cli: CliTransport;
  http: HttpTransport;
  /** Absent when the host runs no actions (an action subscriber then fails for good, with the reason). */
  action?: ActionTransport;
}

/** The subscriber cannot run at all: the configuration is the problem, not the event. */
export interface ConfigFailure {
  kind: 'config';
  error: string;
}

export interface Dispatched {
  kind: 'dispatched';
  result: DispatchResult;
}

/** What the log and the history print as the target of a dispatch: the command, the URL or `action:<name>`. Undefined when the subscriber has none. */
export function targetOf(sub: ResolvedSubscriber): string | undefined {
  return sub.type === 'action' ? `action:${sub.action ?? '?'}` : sub.command ?? sub.url;
}

/**
 * The one place that chooses a transport for a subscriber, shared by the asynchronous and the synchronous dispatcher.
 * `timeoutMs` is the one the caller applies (the subscriber's own, or the one of a `before*` push).
 */
export async function runSubscriber(sub: ResolvedSubscriber, envelope: EventEnvelope, timeoutMs: number, transports: Transports): Promise<ConfigFailure | Dispatched> {
  if (sub.configProblem !== undefined) {
    return { kind: 'config', error: sub.configProblem };
  }
  const type = sub.type;
  switch (type) {
    case 'cli': {
      if (!sub.command) {
        return { kind: 'config', error: `subscriber ${sub.subscriberId} has type 'cli' but no 'command' field in subscribers.yml` };
      }
      if (sub.cwdProblem !== undefined) {
        return { kind: 'config', error: sub.cwdProblem };
      }
      return { kind: 'dispatched', result: await transports.cli.dispatch(sub.command, envelope, timeoutMs, sub.cwd, sub.env, sub.subscriberId) };
    }
    case 'http': {
      if (!sub.url) {
        return { kind: 'config', error: `subscriber ${sub.subscriberId} has type 'http' but no 'url' field in subscribers.yml` };
      }
      return { kind: 'dispatched', result: await transports.http.dispatch(sub.url, sub.method ?? 'POST', sub.headers, envelope, timeoutMs) };
    }
    case 'action': {
      if (!sub.action) {
        return { kind: 'config', error: `subscriber ${sub.subscriberId} has type 'action' but no 'action' field in subscribers.yml` };
      }
      if (transports.action === undefined) {
        return { kind: 'config', error: `subscriber ${sub.subscriberId} has type 'action', but this process runs no actions. Fix: run the event through the queue daemon (queue start), which registers the action plugins.` };
      }
      return { kind: 'dispatched', result: await transports.action.dispatch(sub.action, sub.with ?? {}, envelope, timeoutMs, sub.subscriberId) };
    }
    default: {
      // Compile-time exhaustiveness: a new subscriber type must get its branch here, or an unknown type would silently fall into another transport
      const unreachable: never = type;
      return { kind: 'config', error: `subscriber ${sub.subscriberId} has an unknown type ${JSON.stringify(unreachable)}. Fix: use 'cli', 'http' or 'action'.` };
    }
  }
}
