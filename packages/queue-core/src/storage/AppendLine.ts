import { openSync, closeSync, fstatSync, readSync, writeSync } from 'node:fs';

/**
 * Appends one line to an ndjson file, on a line of its own: if the file is not empty and does not end with a newline (a crash cut the previous append short),
 * a newline is written first, in the same write. Without it the new record is glued to the torn tail and both are lost to every reader.
 * Used by the append-only files (history/ and logs/); WAL and DLQ are rewritten whole instead.
 */
export function appendLine(file: string, line: string): void {
  const fd = openSync(file, 'a+');
  try {
    const size = fstatSync(fd).size;
    let separator = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        separator = '\n';
      }
    }
    writeSync(fd, separator + line, null, 'utf-8');
  } finally {
    closeSync(fd);
  }
}
