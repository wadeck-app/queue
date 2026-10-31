/** An action chain (an action emits an event whose subscriber emits again...) is cut at this many hops: the event that would exceed it is refused. */
export const MAX_ACTION_HOPS = 5;
