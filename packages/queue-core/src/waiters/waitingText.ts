// At most this many names are written; the rest is "... +k more"
const MAX_NAMES = 3;

// A name comes from a file another process wrote: no control character reaches a terminal or a toast
function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '');
}

/** `2 waiting: a.b, c.d`, or `5 waiting: a.b, c.d, e.f ... +2 more`; just `2 waiting` when the names are not known. `count` is the real number (the daemon names 20 at most). */
export function describeWaiting(count: number, names: readonly string[] | undefined): string {
  const shown = (names ?? []).slice(0, Math.min(MAX_NAMES, count)).map(printable);
  if (shown.length === 0) {
    return `${count} waiting`;
  }
  const more = count - shown.length;
  return `${count} waiting: ${shown.join(', ')}${more > 0 ? ` ... +${more} more` : ''}`;
}
