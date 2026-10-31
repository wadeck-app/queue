/** What `queue wait <event>` learns from the event catalog (read-only): is the name declared, what looks like it, when was it last pushed. */

import { EventMatcher, isEventPattern, listEvents, nearestEventNames } from '@wadeck-app/queue-core';

export interface DeclarationCheck {
  declared: boolean;
  /** Up to three declared names that look like the one asked for. */
  suggestions: string[];
  /** No program declared anything yet: an unknown name proves nothing. */
  catalogEmpty: boolean;
}

export function checkDeclaration(configDir: string, name: string, nowMs: number): DeclarationCheck {
  const listing = listEvents(configDir, { nowMs });
  const declaredNames = listing.events.filter((event) => event.declared).map((event) => event.name);
  const declared = declaredNames.includes(name);
  return {
    declared,
    suggestions: declared ? [] : nearestEventNames(name, declaredNames),
    catalogEmpty: listing.sources.length === 0,
  };
}

/** The latest push, within the last 7 days, of the name or (for a pattern) of any name matching it. */
export function lastSeenOf(configDir: string, name: string, nowMs: number): { at: string; event: string } | null {
  const pattern = isEventPattern(name);
  const candidates = listEvents(configDir, pattern ? { nowMs, match: name } : { nowMs }).events.filter((event) => pattern || event.name === name);
  // The list is sorted by source then name, not by time
  let latest: { at: string; event: string } | null = null;
  for (const { lastSeenAt, name: eventName } of candidates) {
    if (lastSeenAt !== null && (latest === null || lastSeenAt > latest.at)) {
      latest = { at: lastSeenAt, event: eventName };
    }
  }
  return latest;
}

/** ISO time of the last push of that name (or of a name matching that pattern) within the last 7 days, null when none. */
export function lastSeenAtOf(configDir: string, name: string, nowMs: number): string | null {
  return lastSeenOf(configDir, name, nowMs)?.at ?? null;
}

/** The concrete name behind `lastSeenAtOf` for a pattern, null when none. */
export function lastSeenEventOf(configDir: string, pattern: string, nowMs: number): string | null {
  return lastSeenOf(configDir, pattern, nowMs)?.event ?? null;
}

export interface PatternCheck {
  /** A declared name or a name pushed in the last 7 days matches the pattern. */
  known: boolean;
  /** No program declared anything and nothing was pushed: an unmatched pattern proves nothing. */
  catalogEmpty: boolean;
}

/** Does any declared or recently pushed event name match this pattern? */
export function patternMatchesKnownEvent(configDir: string, pattern: string, nowMs: number): PatternCheck {
  const listing = listEvents(configDir, { nowMs });
  return {
    known: listing.events.some((event) => EventMatcher.matches(pattern, event.name)),
    catalogEmpty: listing.sources.length === 0 && listing.events.length === 0,
  };
}

/** The stderr line for a pattern that matches no known name (no trailing newline). Not a refusal: names may come later. */
export function patternWarning(pattern: string, check: PatternCheck): string {
  if (check.catalogEmpty) {
    return `[info] No program declared its events yet and nothing was pushed in the last 7 days, so the pattern "${pattern}" cannot be checked (see "queue events --help").`;
  }
  return `[warn] no known event matches "${pattern}" (declared, or pushed in the last 7 days): check the pattern, or ignore this if its producers have not run yet. "queue events list" shows the known names.`;
}

/** The stderr line for an undeclared name (no trailing newline). */
export function undeclaredWarning(name: string, check: DeclarationCheck): string {
  if (check.catalogEmpty) {
    return `[warn] No program declared its events yet, so "${name}" cannot be checked (see "queue events --help").`;
  }
  const base = `[warn] "${name}" is not declared by any program`;
  return check.suggestions.length > 0 ? `${base}; did you mean: ${check.suggestions.join(', ')}` : `${base}; "queue events list" shows the declared names`;
}

/** `--strict`: an undeclared name is refused at once, with exit 4 (invalid usage, as for any unusable `queue wait` argument). */
export function refuseUndeclared(
  name: string,
  check: DeclarationCheck,
  json: boolean,
  io: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } },
): number {
  if (json) {
    io.stdout.write(JSON.stringify({ matched: false, declared: false, suggestions: check.suggestions, event: name }) + '\n');
  }
  io.stderr.write(`${undeclaredWarning(name, check).replace('[warn]', '[fail]')} (--strict: not waiting)\n`);
  return 4;
}
