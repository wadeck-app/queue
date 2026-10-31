import { EventMatcher } from '../dispatch/EventMatcher.js';
import { getErrorMessage } from '../errors.js';
import type { ResolvedSubscriber } from '../types.js';
import type { ActionRegistry } from './ActionRegistry.js';
import { MAX_ACTION_HOPS } from './hopCap.js';

/** What the cycle check needs to know of a subscriber: a `ResolvedSubscriber` fits, so does a subscriber built from a raw subscribers.yml entry. */
export type CycleSubscriber = Pick<ResolvedSubscriber, 'subscriberId' | 'event' | 'type' | 'action' | 'with' | 'when' | 'projectId' | 'fromDescendant' | 'configProblem'>;

export interface ActionCycleFinding {
  /** `error`: no subscriber of the cycle has a `when:`, so the loop is certain to repeat until the runtime hop cap stops it. `warning`: a `when:` may break it. */
  severity: 'error' | 'warning';
  /** The ids of the subscribers of the cycle, in the order an event travels through them. */
  subscribers: string[];
  /** The ids of every subscriber that belongs to the same tangle of cycles (a superset of `subscribers`): lets a caller tell whether a given subscriber is involved. */
  members: string[];
  /** The sentence to show: names the chain, says what to change. */
  message: string;
}

export interface ActionCycleOptions {
  /**
   * For each project id, the ids of the projects whose subscribers.yml an event emitted in it reaches in the default direction (to-parents):
   * the project itself and its ancestors. A project missing from the map reaches only its own file. The global file is always reached.
   */
  chains?: ReadonlyMap<string, readonly string[]>;
}

interface Node {
  subscriber: CycleSubscriber;
  emits: string;
  /** Indexes of the nodes an event emitted by this one reaches. */
  next: number[];
}

/** True when an event emitted by an action of `from` is delivered to the subscribers.yml of `to`, in the default direction. */
function reaches(from: CycleSubscriber, to: CycleSubscriber, chains: ReadonlyMap<string, readonly string[]>): boolean {
  // The global file serves every project
  if (to.projectId === undefined) {
    return true;
  }
  // A global action fires for the events of any project, so the emitted event may land in the project of `to`
  if (from.projectId === undefined) {
    return true;
  }
  // The event is filed under the project of the event that fired the action (the project of `from` or a descendant of it): it reaches that project and its ancestors.
  // The files of the descendants are not reached (the default direction does not go down)
  return (chains.get(from.projectId) ?? [from.projectId]).includes(to.projectId);
}

/** The strongly connected components of the graph that contain a cycle (more than one node, or a node that reaches itself), by Tarjan's algorithm. */
function cyclicComponents(nodes: readonly Node[], included: (index: number) => boolean): number[][] {
  const indexOf = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const found: number[][] = [];
  let counter = 0;

  const visit = (v: number): void => {
    indexOf.set(v, counter);
    lowLink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of nodes[v]!.next) {
      if (!included(w)) {
        continue;
      }
      if (!indexOf.has(w)) {
        visit(w);
        lowLink.set(v, Math.min(lowLink.get(v)!, lowLink.get(w)!));
      } else if (onStack.has(w)) {
        lowLink.set(v, Math.min(lowLink.get(v)!, indexOf.get(w)!));
      }
    }
    if (lowLink.get(v) === indexOf.get(v)) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || nodes[v]!.next.includes(v)) {
        found.push(component);
      }
    }
  };

  for (let v = 0; v < nodes.length; v++) {
    if (included(v) && !indexOf.has(v)) {
      visit(v);
    }
  }
  return found;
}

/** One concrete cycle through `component`, starting at its first node: the shortest way back to it (breadth first). */
function cycleThrough(nodes: readonly Node[], component: readonly number[]): number[] {
  const members = new Set(component);
  const start = Math.min(...component);
  const parent = new Map<number, number>();
  const queue: number[] = [start];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const w of nodes[v]!.next) {
      if (!members.has(w)) {
        continue;
      }
      if (w === start) {
        const path = [v];
        let cursor = v;
        while (cursor !== start) {
          cursor = parent.get(cursor)!;
          path.push(cursor);
        }
        return path.reverse();
      }
      if (!parent.has(w)) {
        parent.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start];
}

function describe(nodes: readonly Node[], path: readonly number[], severity: 'error' | 'warning'): string {
  const steps = path.map((i) => `'${nodes[i]!.subscriber.subscriberId}' (listens to '${nodes[i]!.subscriber.event}', emits '${nodes[i]!.emits}')`);
  const loop = `${steps.join(' -> ')} -> back to '${nodes[path[0]!]!.subscriber.subscriberId}'`;
  if (severity === 'error') {
    return (
      `action loop: ${loop}. None of them has a 'when:', so every event would be emitted again until the hop cap (${MAX_ACTION_HOPS}) refuses it. ` +
      `Fix: make one of them listen to a different event, or add a 'when:' that stops the chain.`
    );
  }
  return (
    `possible action loop: ${loop}. A 'when:' filter may stop it, but queue cannot prove that it does. ` +
    `Fix: check that the 'when:' of one of them is false for the event the previous one emits; the hop cap (${MAX_ACTION_HOPS}) stops a runaway chain anyway.`
  );
}

/**
 * Looks for chains of action subscribers that can trigger themselves: an action emits an event that another action (or the same one) listens to.
 * Pure: it reads the subscribers it is given. Edges follow the real delivery chain only (the emitted event reaches the global file and the files of the emitter's
 * project and its ancestors, not its descendants), so a layout that cannot loop is not reported.
 * An error is a cycle in which no subscriber has a `when:`; a cycle that has one is a warning (the filter may break it). The runtime hop cap is the real guard.
 */
export function findActionCycles(subscribers: readonly CycleSubscriber[], actions: ActionRegistry, options: ActionCycleOptions = {}): ActionCycleFinding[] {
  const chains = options.chains ?? new Map<string, readonly string[]>();
  const nodes: Node[] = [];
  for (const subscriber of subscribers) {
    // Descendant subscribers are only loaded for a to-children push; a subscriber with a configuration problem never runs
    if (subscriber.type !== 'action' || subscriber.action === undefined || subscriber.fromDescendant === true || subscriber.configProblem !== undefined) {
      continue;
    }
    const plugin = actions.get(subscriber.action);
    if (plugin?.emits === undefined) {
      continue;
    }
    let emits: string | undefined;
    try {
      emits = plugin.emits(subscriber.with ?? {});
    } catch (err) {
      throw new Error(`[queue] The action '${subscriber.action}' threw while declaring the event it emits (subscriber '${subscriber.subscriberId}'): ${getErrorMessage(err)}. Fix: the plugin's emits() must not throw.`);
    }
    if (emits !== undefined) {
      nodes.push({ subscriber, emits, next: [] });
    }
  }
  for (const from of nodes) {
    nodes.forEach((to, index) => {
      if (EventMatcher.matches(to.subscriber.event, from.emits) && reaches(from.subscriber, to.subscriber, chains)) {
        from.next.push(index);
      }
    });
  }

  const findings: ActionCycleFinding[] = [];
  const reported = new Set<number>();
  const report = (component: readonly number[], severity: 'error' | 'warning'): void => {
    const path = cycleThrough(nodes, component);
    findings.push({ severity, subscribers: path.map((i) => nodes[i]!.subscriber.subscriberId), members: component.map((i) => nodes[i]!.subscriber.subscriberId), message: describe(nodes, path, severity) });
    for (const index of component) {
      reported.add(index);
    }
  };

  // Certain: a cycle among the subscribers that have no `when:`
  for (const component of cyclicComponents(nodes, (i) => nodes[i]!.subscriber.when === undefined || nodes[i]!.subscriber.when === '')) {
    report(component, 'error');
  }
  // Possible: a cycle that only exists through a subscriber with a `when:` (and was not reported as certain)
  for (const component of cyclicComponents(nodes, () => true)) {
    if (!component.some((index) => reported.has(index))) {
      report(component, 'warning');
    }
  }
  return findings;
}
