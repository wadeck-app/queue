/** Prints a duration for a message: milliseconds under one second ("30ms"), seconds above ("1.2s", "30s"). */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
}
