/** True for a plain JSON-like object (not null, not an array); lets unknown data be read without a cast. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
