import type { ActionPlugin } from './ActionPlugin.js';

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The set of action plugins a process can run. An instance, not a global map: each host (daemon, tests, a CLI check) builds its own. */
export class ActionRegistry {
  // Both the names and the aliases, pointing at their plugin
  private readonly byName = new Map<string, ActionPlugin>();
  private readonly plugins: ActionPlugin[] = [];

  /** Adds a plugin. Throws on a malformed name or when the name or an alias is already taken: two plugins must never compete for one `action:` value. */
  register(plugin: ActionPlugin): void {
    const names = [plugin.name, ...(plugin.aliases ?? [])];
    for (const name of names) {
      if (!ACTION_NAME_PATTERN.test(name)) {
        throw new Error(
          `[queue] Cannot register the action ${JSON.stringify(name)}: an action name must match [a-z][a-z0-9-]* and be at most 64 characters.\n` +
          `Fix: rename the plugin (or its alias) to a lowercase name such as 'agent-wake'.`
        );
      }
      const owner = this.byName.get(name);
      if (owner !== undefined) {
        throw new Error(
          `[queue] Cannot register the action '${name}' (plugin '${plugin.name}'): the name is already taken by the plugin '${owner.name}'.\n` +
          `Fix: give one of the two plugins another name or alias; the registered actions are: ${this.names().join(', ')}.`
        );
      }
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`[queue] Cannot register the action '${plugin.name}': its aliases repeat a name. Fix: list each alias once.`);
    }
    for (const name of names) {
      this.byName.set(name, plugin);
    }
    this.plugins.push(plugin);
  }

  /** The plugin selected by `action:` (a name or an alias), undefined when none. */
  get(name: string): ActionPlugin | undefined {
    return this.byName.get(name);
  }

  /** The names of the registered plugins (not their aliases), in registration order. */
  names(): string[] {
    return this.plugins.map((plugin) => plugin.name);
  }

  /** The sentence that says an `action:` value is unknown and lists the ones that exist. */
  unknownActionProblem(name: string): string {
    return `unknown action ${JSON.stringify(name)}. Available actions: ${this.names().join(', ')}. Fix: use one of them, or install the plugin that provides ${JSON.stringify(name)}.`;
  }

  /** The plugin selected by `action:`; throws with the list of the available ones when there is none. */
  resolve(name: string): ActionPlugin {
    const plugin = this.byName.get(name);
    if (plugin === undefined) {
      throw new Error(`[queue] ${this.unknownActionProblem(name)}`);
    }
    return plugin;
  }
}
