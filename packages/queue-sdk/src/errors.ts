/** Message of anything that was thrown. Same helper as queue-core's, restated because the SDK has no dependency. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
