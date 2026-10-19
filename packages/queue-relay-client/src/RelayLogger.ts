import { getErrorMessage } from '@wadeck-app/queue-core';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RelayLoggerOptions {
  rotationThresholdBytes?: number;
}

const DEFAULT_ROTATION_THRESHOLD = 1024 * 1024; // 1 MiB

// Helper: check if error is ENOENT (file doesn't exist)
function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

// Helper: build error message appropriate to the failure context
function describe(error: Error, logFilePath: string, isAppendError: boolean): string {
  const errorMsg = getErrorMessage(error);
  const errorCode = 'code' in error ? ` (${(error as NodeJS.ErrnoException).code})` : '';

  if (isAppendError) {
    // Append failures mean data is not being persisted
    return `[queue-relay-client] Cannot write relay log "${logFilePath}": ${errorMsg}${errorCode}. Relay messages are NOT being persisted. Check that the folder exists, is writable and has free disk space.`;
  } else {
    // Rotation failures mean the file grows without cleanup
    return `[queue-relay-client] Cannot rotate relay log "${logFilePath}": ${errorMsg}${errorCode}. Lines are still appended but the file will keep growing; check that nothing else holds the file open and that "${logFilePath}.1" is not a directory.`;
  }
}

/**
 * Creates a relay logger that appends timestamped lines to a file.
 * On write failure, emits one stderr message and continues silently thereafter.
 * Rotates logs when exceeding the threshold (default 1 MiB) by renaming to .1.
 * Returns a callable logger with getLastError() method to retrieve the last failure (if any).
 */
export function createRelayLogger(
  logFilePath: string,
  opts?: RelayLoggerOptions
): ((line: string) => void) & { getLastError: () => string | null } {
  const threshold = opts?.rotationThresholdBytes ?? DEFAULT_ROTATION_THRESHOLD;
  let hasErrored = false;
  let lastErrorMessage: string | null = null;

  // Ensure parent directories exist when creating the logger
  try {
    const parentDir = dirname(logFilePath);
    mkdirSync(parentDir, { recursive: true });
  } catch {
    // mkdirSync may fail (e.g., permission denied), but we'll report it on first write if needed
  }

  const logFn = (line: string) => {
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} ${line}\n`;
    let rotationError: Error | null = null;

    // Check file size before writing and attempt rotation
    try {
      const stats = statSync(logFilePath);
      if (stats.size >= threshold) {
        // Rotate: rename current to .1 (overwrites any existing .1)
        const rotatedPath = `${logFilePath}.1`;
        try {
          renameSync(logFilePath, rotatedPath);
        } catch (renameErr) {
          // Only ignore ENOENT (file doesn't exist yet); record other errors but continue appending
          if (renameErr instanceof Error && !isEnoent(renameErr)) {
            rotationError = renameErr;
          }
        }
      }
    } catch (statErr) {
      // Only ignore ENOENT (file doesn't exist yet); record other errors but continue
      if (statErr instanceof Error && !isEnoent(statErr)) {
        rotationError = statErr;
      }
    }

    // Try to append the line (even if rotation failed)
    let appendError: Error | null = null;
    try {
      appendFileSync(logFilePath, logLine);
    } catch (error) {
      appendError = error as Error;
    }

    // Report whichever error occurred (prioritize append error, fall back to rotation error)
    const errorToReport = appendError || rotationError;
    if (errorToReport) {
      const isAppendError = !!appendError;
      if (!hasErrored) {
        hasErrored = true;
        lastErrorMessage = describe(errorToReport, logFilePath, isAppendError);
        process.stderr.write(lastErrorMessage + '\n');
      } else {
        // Update lastErrorMessage even if we don't print stderr again
        lastErrorMessage = describe(errorToReport, logFilePath, isAppendError);
      }
    }
  };

  return Object.assign(logFn, {
    getLastError: () => lastErrorMessage,
  });
}
