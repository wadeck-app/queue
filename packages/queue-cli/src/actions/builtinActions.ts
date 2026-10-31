import { agentWakeAction } from '@wadeck-app/plugin-agent-wake';
import { createActionRegistry, type ActionPlugin, type ActionRegistry } from '@wadeck-app/queue-core';

/** The action plugins shipped inside the CLI (besides the generic `emit` that queue-core always registers): the daemon runs them, `queue sub add|edit` checks against them. */
export const BUILTIN_ACTION_PLUGINS: readonly ActionPlugin[] = [agentWakeAction];

/** A registry with `emit` and every built-in plugin. One per process: the daemon and the CLI each build their own. */
export function createBuiltinActionRegistry(): ActionRegistry {
  return createActionRegistry(BUILTIN_ACTION_PLUGINS);
}
