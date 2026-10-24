import { getErrorMessage } from './errors.js';

// Failure reporting. `onError` receives every failure; the default console output is deduplicated so a daemon that is down does
// not print one line per event. Messages say what happened and what to do, and never contain the token.

export type FailureKind =
  | 'not-installed'
  | 'start-failed'
  | 'not-ready'
  | 'corrupt-port-file'
  | 'no-token'
  | 'unauthorized'
  | 'incompatible'
  | 'rejected'
  | 'aborted'
  | 'http-error'
  | 'bad-answer'
  | 'unknown-outcome'
  | 'not-serialisable'
  | 'overflow'
  | 'invalid-argument'
  | 'unexpected';

export interface QueueFailure {
  kind: FailureKind;
  /** What happened and what to do about it. */
  message: string;
  event: string;
  /** `dropped`: the event was not queued. `unknown`: it may have been (connection reset, timeout), and it is never retried. */
  outcome: 'dropped' | 'unknown';
}

export interface ReporterOptions {
  silent?: boolean | undefined;
  onError?: ((failure: QueueFailure) => void) | undefined;
  onWarning?: ((warning: string) => void) | undefined;
  /** Where the default output goes (default console.warn). */
  sink?: ((line: string) => void) | undefined;
}

export interface Reporter {
  failure(failure: QueueFailure): void;
  /** A push succeeded: the next failure is printed again. */
  success(): void;
  /** Daemon notices of a push answer, each delivered once. */
  warnings(warnings: string[]): void;
  /** A notice about the SDK's own configuration, delivered once: to `onWarning`, else printed (unless silent). */
  notice(text: string): void;
}


export function createReporter(options: ReporterOptions): Reporter {
  const sink = options.sink ?? ((line: string): void => console.warn(line));
  const print = (line: string): void => {
    if (options.silent !== true) {
      sink(line);
    }
  };
  let printed = new Set<string>();
  const seenWarnings = new Set<string>();
  return {
    failure(failure: QueueFailure): void {
      try {
        options.onError?.(failure);
      } catch (error) {
        print(`[queue-sdk] the onError callback threw: ${getErrorMessage(error)}`);
      }
      const key = `${failure.kind}\u0000${failure.message}`;
      if (printed.has(key)) {
        return;
      }
      printed.add(key);
      const effect = failure.outcome === 'unknown' ? 'may or may not have been queued' : 'was dropped';
      print(`[queue-sdk] event "${failure.event}" ${effect}: ${failure.message}`);
    },
    success(): void {
      printed = new Set<string>();
    },
    notice(text: string): void {
      if (seenWarnings.has(text)) {
        return;
      }
      seenWarnings.add(text);
      if (options.onWarning !== undefined) {
        try {
          options.onWarning(text);
        } catch (error) {
          print(`[queue-sdk] the onWarning callback threw: ${getErrorMessage(error)}`);
        }
      } else {
        print(`[queue-sdk] ${text}`);
      }
    },
    warnings(warnings: string[]): void {
      for (const warning of warnings) {
        if (seenWarnings.has(warning)) {
          continue;
        }
        seenWarnings.add(warning);
        if (options.onWarning !== undefined) {
          try {
            options.onWarning(warning);
          } catch (error) {
            print(`[queue-sdk] the onWarning callback threw: ${getErrorMessage(error)}`);
          }
        } else {
          print(`[queue-sdk] warning from the queue daemon: ${warning}`);
        }
      }
    },
  };
}

const EXCERPT_LENGTH = 300;

/** A short single-line excerpt of a response body, with every secret masked. */
export function excerpt(text: string, secrets: readonly string[]): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('***');
    }
  }
  return out.length > EXCERPT_LENGTH ? `${out.slice(0, EXCERPT_LENGTH)}...` : out;
}

/** The message for an HTTP error status of the daemon (400, 401 after the retry, 404, 500 and the rest). */
export function describeHttpError(status: number, body: string, secrets: readonly string[]): string {
  const shown = excerpt(body, secrets);
  const detail = shown === '' ? '(empty body)' : shown;
  if (status === 401) {
    return `the daemon refused the token (HTTP 401) even after re-reading it: check that health_token in the config dir belongs to the running daemon, or restart it with \`queue stop\` then \`queue start\``;
  }
  if (status === 404) {
    return `the daemon does not know the push command (HTTP 404, ${detail}): it is older than this SDK, update queue-cli`;
  }
  if (status === 500) {
    return `the daemon failed to handle the event (HTTP 500): ${detail}`;
  }
  return `the daemon answered HTTP ${status}: ${detail}`;
}
