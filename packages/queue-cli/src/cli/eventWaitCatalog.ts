/** What `queue wait <event>` learns from the event catalog (read-only): is the name declared, what looks like it, when was it last pushed. */

import { listEvents, nearestEventNames } from '@wadeck-app/queue-core';

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

/** ISO time of the last push of that name within the last 7 days, null when none. */
export function lastSeenAtOf(configDir: string, name: string, nowMs: number): string | null {
  return listEvents(configDir, { nowMs }).events.find((event) => event.name === name)?.lastSeenAt ?? null;
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
