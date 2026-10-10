/**
 * Prepares child-process output for persistence in the event log.
 *
 * Rationale: a failing `cli` subscriber used to leave only "exited with code 3" on disk while the
 * actual cause (missing module, daemon start timeout, ...) was written on the child's stderr and
 * then discarded. Every failure must carry its own explanation.
 */

/** Max bytes kept per stream. The tail is kept: the explanation of a failure sits at the end. */
export const MAX_CAPTURED_BYTES = 4_096;

export interface CapturedOutput {
  stdout?: string;
  stderr?: string;
}

export class OutputCapture {
  /** Keeps the last maxBytes of text, prefixed with an explicit marker when anything was dropped. */
  static tail(text: string, maxBytes: number = MAX_CAPTURED_BYTES): string {
    if (maxBytes <= 0) {
      throw new Error(`OutputCapture.tail: maxBytes must be > 0, got ${maxBytes}`);
    }
    const buffer = Buffer.from(text, 'utf-8');
    if (buffer.byteLength <= maxBytes) return text;
    const kept = buffer.subarray(buffer.byteLength - maxBytes).toString('utf-8');
    return `[truncated: kept last ${maxBytes} of ${buffer.byteLength} bytes]\n${kept}`;
  }

  /**
   * Failure: both streams are kept - the cause is usually on stderr, but subscribers routinely
   * print their errors on stdout.
   * Success: only a non-empty stderr is kept (warnings a human should still see). stdout is dropped
   * on purpose: it is the sync-dispatch protocol channel and a chatty subscriber would bloat the
   * log with no diagnostic value.
   * Blank streams are omitted entirely so log lines stay readable.
   */
  static forLog(
    success: boolean,
    stdout: string | undefined,
    stderr: string | undefined,
    maxBytes: number = MAX_CAPTURED_BYTES
  ): CapturedOutput {
    const captured: CapturedOutput = {};
    if (!success && stdout !== undefined && stdout.trim() !== '') {
      captured.stdout = OutputCapture.tail(stdout, maxBytes);
    }
    if (stderr !== undefined && stderr.trim() !== '') {
      captured.stderr = OutputCapture.tail(stderr, maxBytes);
    }
    return captured;
  }
}
