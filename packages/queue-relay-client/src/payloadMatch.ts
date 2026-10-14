/**
 * Matches a payload against a filter with support for dotted paths.
 * Returns true if all match conditions are satisfied (AND logic).
 * Empty or undefined match always returns true.
 *
 * Limitations:
 * - Max depth: 8 segments
 * - No array indexing
 * - Segments __proto__, constructor, prototype are never matched (prototype pollution protection)
 * - Payload must be an object
 * - Strict equality (type-sensitive) for scalar values
 */
export function matchesPayload(
  payload: unknown,
  match: Record<string, string | number | boolean> | undefined
): boolean {
  // Empty or undefined match always succeeds
  if (!match || Object.keys(match).length === 0) {
    return true;
  }

  // Payload must be a plain object
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  // Check all match conditions (AND logic)
  for (const [key, expectedValue] of Object.entries(match)) {
    // Handle dotted paths
    const segments = key.split('.');

    // Max depth check
    if (segments.length > 8) {
      return false;
    }

    // Check for dangerous segments (prototype pollution protection)
    if (segments.some((seg) => seg === '__proto__' || seg === 'constructor' || seg === 'prototype')) {
      return false;
    }

    // Navigate through the object following the dotted path
    let current: unknown = payload;
    for (const segment of segments) {
      // Current must be an object to traverse further
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        // Path doesn't exist or intermediate is not an object
        return false;
      }

      // Get the next level
      current = (current as Record<string, unknown>)[segment];
    }

    // Strict equality check
    if (current !== expectedValue) {
      return false;
    }
  }

  return true;
}
