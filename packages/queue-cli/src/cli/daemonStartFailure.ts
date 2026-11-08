import { getErrorMessage, readLogTail } from '@wadeck-app/queue-core';

export interface DaemonLogTail {
  file: string;
  present: boolean;
  lines: string[];
}

const TAIL_LINES = 5;

/** The last lines of today's daemon log, or the error that prevented reading it. */
export function readDaemonLogTail(configDir: string): DaemonLogTail | Error {
  try {
    const tail = readLogTail(configDir, { limit: TAIL_LINES });
    return { file: tail.file, present: tail.present, lines: tail.lines };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * What `queue start` (and every command that starts the daemon on demand) says when the daemon is not up after the wait. The daemon is spawned with
 * no output, so its own log (startup failures included) is the only place the cause is written.
 */
export function daemonStartFailureMessage(input: { configDir: string; daemonScript: string; tail: DaemonLogTail | Error }): string {
  const lines = ['[fail] daemon failed to start within 5s.'];
  if (input.tail instanceof Error) {
    lines.push(`The daemon log could not be read: ${getErrorMessage(input.tail)}`);
  } else if (input.tail.present) {
    lines.push('Log output:');
    for (const line of input.tail.lines) {
      lines.push(`  | ${line}`);
    }
    lines.push(`Full log: ${input.tail.file}`);
  } else {
    lines.push(`No log was written (${input.tail.file}): the process died before logging.`);
  }
  lines.push(`Fix: run the daemon in the foreground to see the error: QUEUE_CONFIG_DIR=${input.configDir} node ${input.daemonScript}`);
  return lines.join('\n') + '\n';
}
