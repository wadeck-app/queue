export interface Choice {
  /** The id, URL-encoded: the dashboard builds an action URL from it by text substitution, which does not encode. */
  value: string;
  label: string;
}

/** Entries as the choices of a dashboard form select. */
export function toChoices(items: ReadonlyArray<{ id: string; label: string }>): Choice[] {
  return items.map((item) => ({ value: encodeURIComponent(item.id), label: item.label }));
}
