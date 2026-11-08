/** Bytes kept from the start of one output stream of a cli subscriber (a JSON answer on stdout is read from the start). */
export const MAX_CLI_OUTPUT_HEAD_BYTES = 1_048_576;

/** Bytes kept from the end of one output stream (the explanation of a failure sits at the end; the log keeps far less than this). */
export const MAX_CLI_OUTPUT_TAIL_BYTES = 65_536;

/**
 * Collects the output of a child process in bounded memory: the first MAX_CLI_OUTPUT_HEAD_BYTES and the last MAX_CLI_OUTPUT_TAIL_BYTES are kept,
 * the middle is dropped and replaced by an explicit marker in `toString()`. Bytes are decoded once at the end, so a multi-byte character split
 * between two chunks stays intact.
 */
export class BoundedOutput {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  private dropped = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < MAX_CLI_OUTPUT_HEAD_BYTES) {
      const room = MAX_CLI_OUTPUT_HEAD_BYTES - this.headBytes;
      const taken = rest.subarray(0, room);
      this.head.push(taken);
      this.headBytes += taken.byteLength;
      rest = rest.subarray(taken.byteLength);
    }
    if (rest.byteLength === 0) {
      return;
    }
    const combined = Buffer.concat([this.tail, rest]);
    if (combined.byteLength > MAX_CLI_OUTPUT_TAIL_BYTES) {
      this.dropped += combined.byteLength - MAX_CLI_OUTPUT_TAIL_BYTES;
      this.tail = combined.subarray(combined.byteLength - MAX_CLI_OUTPUT_TAIL_BYTES);
    } else {
      this.tail = combined;
    }
  }

  toString(): string {
    const head = Buffer.concat(this.head);
    if (this.dropped === 0) {
      return Buffer.concat([head, this.tail]).toString('utf-8');
    }
    const marker = `\n[output truncated: ${this.dropped} bytes dropped, kept the first ${this.headBytes} and the last ${this.tail.byteLength} bytes]\n`;
    return head.toString('utf-8') + marker + this.tail.toString('utf-8');
  }
}
