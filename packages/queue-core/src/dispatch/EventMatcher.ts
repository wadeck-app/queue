/** True when a segment of `s` is exactly `*`, `>` or `**`: `s` is a subscribers.yml pattern, not a concrete event name. */
export function isEventPattern(s: string): boolean {
  return s.split('.').some((segment) => segment === '*' || segment === '>' || segment === '**');
}

/**
 * Why `s` cannot be used as an event pattern, null when it is fine (or when it holds no wildcard character at all: a concrete name).
 * A wildcard character must be a whole segment (`*`, `>`, `**`), no segment may be empty, and `>` / `**` must come last.
 */
export function eventPatternProblem(s: string): string | null {
  if (!/[*>]/.test(s)) {
    return null;
  }
  const segments = s.split('.');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '') {
      return `"${s}" has an empty segment (a leading, trailing or doubled dot).`;
    }
    if (/[*>]/.test(segment) && segment !== '*' && segment !== '>' && segment !== '**') {
      return `"${s}": "${segment}" mixes a wildcard with other characters. A wildcard must be a whole segment: "*" (one segment) or ">" (one or more remaining segments).`;
    }
    if ((segment === '>' || segment === '**') && i !== segments.length - 1) {
      return `"${s}": "${segment}" matches all the remaining segments, so it must be the last one.`;
    }
  }
  return null;
}

export class EventMatcher {
  static matches(pattern: string, event: string): boolean {
    if (pattern === '**' || pattern === '>') {
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

      if (p === '**' || p === '>') {
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
