import { getErrorMessage } from '@wadeck-app/queue-core';

export interface LastResortDeps {
  /** The process (or a test double) whose uncaught failures are caught. */
  proc: Pick<NodeJS.Process, 'on'>;
  /** Where the cause goes (relay.log and stderr in production). */
  log: (line: string) => void;
  exit: (code: number) => void;
}

function describeCause(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : getErrorMessage(err);
}

/**
 * Last resort of the relay daemon: an exception or a rejection nobody handled is written to relay.log with its cause, then the
 * process exits with code 1. Without it the process dies with the cause on a stderr nobody reads (it is spawned detached).
 */
export function installLastResortHandlers(deps: LastResortDeps): void {
  let exiting = false;
  const fail = (kind: string, err: unknown): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    try {
      deps.log(`[relay] Relay daemon crashed on an ${kind}: ${describeCause(err)}. Restart it with 'queue relay start'; if it keeps happening, report this line.`);
    } finally {
      deps.exit(1);
    }
  };
  deps.proc.on('uncaughtException', (err) => fail('uncaught exception', err));
  deps.proc.on('unhandledRejection', (reason) => fail('unhandled promise rejection', reason));
}
