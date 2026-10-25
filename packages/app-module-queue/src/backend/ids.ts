/** The first 8 characters of an event id: enough to tell two rows apart in a table (the full id is the tooltip and what the row actions use). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
