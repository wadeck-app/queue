/** True when a segment of `s` is exactly `*` or `>`: `s` is a subscribers.yml pattern, not a concrete event name. */
export function isEventPattern(s: string): boolean {
  return s.split('.').some((segment) => segment === '*' || segment === '>');
}

/**
 * Why `s` is refused because of a `**` segment, null when it has none. `**` is not a wildcard (`>` is the only multi-segment one):
 * left alone it would be a literal segment that never matches, so every place that takes a pattern refuses it with this message.
 */
export function doubleStarProblem(s: string): string | null {
  const segments = s.split('.');
  if (!segments.includes('**')) {
    return null;
  }
  const suggestion = segments.map((segment) => (segment === '**' ? '>' : segment)).join('.');
  return `"${s}": "**" is not a wildcard, use ">" (the rest of the segments) instead: "${suggestion}".`;
}

/**
 * Why `s` cannot be used as an event pattern, null when it is fine (or when it holds no wildcard character at all: a concrete name).
 * A wildcard character must be a whole segment (`*`, `>`), no segment may be empty, `>` must come last, and `**` is refused (use `>`).
 */
export function eventPatternProblem(s: string): string | null {
  const doubleStar = doubleStarProblem(s);
  if (doubleStar !== null) {
    return doubleStar;
  }
  if (!/[*>]/.test(s)) {
    return null;
  }
  const segments = s.split('.');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '') {
      return `"${s}" has an empty segment (a leading, trailing or doubled dot).`;
    }
    if (/[*>]/.test(segment) && segment !== '*' && segment !== '>') {
      return `"${s}": "${segment}" mixes a wildcard with other characters. A wildcard must be a whole segment: "*" (one segment) or ">" (one or more remaining segments).`;
    }
    if (segment === '>' && i !== segments.length - 1) {
      return `"${s}": "${segment}" matches all the remaining segments, so it must be the last one.`;
    }
  }
  return null;
}

export class EventMatcher {
  static matches(pattern: string, event: string): boolean {
    if (pattern === '>') {
      return true;
    }

    const patternParts = pattern.split('.');
    const eventParts = event.split('.');

    return EventMatcher.matchParts(patternParts, eventParts);
  }

  private static matchParts(patternParts: string[], eventParts: string[]): boolean {
    let pi = 0;
    let ei = 0;

    while (pi < patternParts.length && ei < eventParts.length) {
      const p = patternParts[pi]!;

      if (p === '>') {
        // Multi-segment wildcard: matches remaining segments
        return true;
      }

      if (p === '*') {
        // Single-segment wildcard: matches exactly one segment
        pi++;
        ei++;
        continue;
      }

      if (p === eventParts[ei]) {
        pi++;
        ei++;
        continue;
      }

      return false;
    }

    return pi === patternParts.length && ei === eventParts.length;
  }
}
