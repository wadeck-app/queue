import type { ActionPlugin } from './ActionPlugin.js';
import { ActionRegistry } from './ActionRegistry.js';
import { emitAction } from './emit.js';

/** A registry with the generic `emit` action, plus the given plugins (the daemon passes the ones the CLI bundles). */
export function createActionRegistry(plugins: readonly ActionPlugin[] = []): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(emitAction);
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  return registry;
}
