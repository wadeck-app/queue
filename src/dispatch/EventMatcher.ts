export class EventMatcher {
  static matches(pattern: string, event: string): boolean {
    if (pattern === '**' || pattern === '>') return true;

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
