/**
 * The most events the actions of one chain may emit, all branches together. The hop cap bounds the depth of a chain, not its width: three actions that emit the event
 * they listen to made 364 events for one push (and ten, about 111 000). Counted per root event (the first push of the chain), in the daemon's memory.
 */
export const MAX_ACTION_EMISSIONS_PER_ROOT = 100;

/** Roots tracked at once: past it the oldest are forgotten, so the map cannot grow with the number of pushes. */
const MAX_TRACKED_ROOTS = 10_000;
/** A root untouched for this long is forgotten (a chain lasts seconds; a retry hours later starts a new budget). */
const ROOT_TTL_MS = 60 * 60 * 1000;

export interface EmissionBudgetOptions {
  maxPerRoot?: number;
  maxRoots?: number;
  ttlMs?: number;
  /** Test seam: the clock. */
  now?: () => number;
}

export type EmissionReservation = { granted: true } | { granted: false; count: number; firstRefusal: boolean };

interface RootState {
  count: number;
  touchedAt: number;
  refused: boolean;
}

/** The emission budget of every root event: bounded in memory (time to live and number of roots). */
export class EmissionBudget {
  private readonly roots = new Map<string, RootState>();
  private readonly maxPerRoot: number;
  private readonly maxRoots: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: EmissionBudgetOptions = {}) {
    this.maxPerRoot = options.maxPerRoot ?? MAX_ACTION_EMISSIONS_PER_ROOT;
    this.maxRoots = options.maxRoots ?? MAX_TRACKED_ROOTS;
    this.ttlMs = options.ttlMs ?? ROOT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.roots.size;
  }

  /** Takes one emission from the budget of `rootId`. A refusal says whether it is the first for that root (the caller says it once). */
  reserve(rootId: string): EmissionReservation {
    const now = this.now();
    this.evict(now);
    let state = this.roots.get(rootId);
    if (state === undefined) {
      state = { count: 0, touchedAt: now, refused: false };
      this.roots.set(rootId, state);
      this.dropOldestBeyondBound();
    }
    state.touchedAt = now;
    if (state.count >= this.maxPerRoot) {
      const firstRefusal = !state.refused;
      state.refused = true;
      return { granted: false, count: state.count, firstRefusal };
    }
    state.count++;
    return { granted: true };
  }

  /** Gives back the emission of a reservation whose push was refused: only an event that exists counts. */
  release(rootId: string): void {
    const state = this.roots.get(rootId);
    if (state !== undefined && state.count > 0) {
      state.count--;
    }
  }

  private evict(now: number): void {
    // Insertion order is creation order, but touches move the age: scan all (bounded by maxRoots)
    for (const [id, state] of this.roots) {
      if (now - state.touchedAt > this.ttlMs) {
        this.roots.delete(id);
      }
    }
  }

  private dropOldestBeyondBound(): void {
    while (this.roots.size > this.maxRoots) {
      const oldest = this.roots.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.roots.delete(oldest.value);
    }
  }
}
