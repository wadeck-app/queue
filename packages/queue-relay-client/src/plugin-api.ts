/**
 * Contract every relay plugin package implements. This module owns the
 * contract only -- it must never import or reference anything Source-specific
 * (no "github", "slack", "jira", ...). That belongs exclusively in the plugin
 * packages themselves (e.g. @wadeck-app/plugin-github). queue-relay-client is
 * shared infrastructure used BY every plugin; it is not a plugin itself.
 */

import { getErrorMessage } from '@wadeck-app/queue-core';

export interface RelayEnvelope {
  source: string;
  webhookConfigId: string;
  eventType: string;
  receivedAt: string;
  deliveryId: string;
  payload: unknown;
  headers: Record<string, string>;
}

export interface MappedEvent {
  event: string;
  payload: unknown;
}

export interface RelayPlugin {
  /** Must match the relay's Source identifier exactly (e.g. "github"). */
  source: string;
  /** Returns null to drop the event -- a deliberate choice by the plugin, not an error. */
  mapEvent: (envelope: RelayEnvelope) => MappedEvent | null;
}

function isRelayPlugin(value: unknown): value is RelayPlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RelayPlugin>;
  return typeof candidate.source === 'string' && typeof candidate.mapEvent === 'function';
}

// Built-in plugin registry: maps module names/aliases to RelayPlugin instances.
// Used by loadPlugin to resolve plugins without dynamic import in bundled/published contexts.
const builtinRegistry = new Map<string, RelayPlugin>();

/**
 * Registers a built-in plugin by name and optional aliases. Validates that the
 * plugin object conforms to RelayPlugin. Throws if the name or any alias is
 * already registered with a different plugin object. Re-registering the
 * identical object is a no-op.
 * @param moduleName - The primary name (must not conflict with existing names/aliases)
 * @param plugin - The RelayPlugin instance
 * @param aliases - Optional list of aliases that also resolve to this plugin
 * @throws if plugin is invalid, or name/alias already registered with a different plugin
 */
export function registerBuiltinPlugin(
  moduleName: string,
  plugin: RelayPlugin,
  aliases: string[] = []
): void {
  if (!isRelayPlugin(plugin)) {
    throw new Error(
      `[queue-relay-client] Plugin for "${moduleName}" does not conform to RelayPlugin ` +
      `(expected { source: string, mapEvent: function }).`
    );
  }

  // Check if moduleName is already registered
  const existing = builtinRegistry.get(moduleName);
  if (existing && existing !== plugin) {
    throw new Error(
      `[queue-relay-client] Plugin name "${moduleName}" is already registered with a different plugin object.`
    );
  }

  // Check if any alias is already registered
  const allNames = [moduleName, ...aliases];
  for (const name of allNames) {
    const existingByAlias = builtinRegistry.get(name);
    if (existingByAlias && existingByAlias !== plugin) {
      throw new Error(
        `[queue-relay-client] Plugin name/alias "${name}" is already registered with a different plugin object.`
      );
    }
  }

  // Register the module name and all aliases
  for (const name of allNames) {
    builtinRegistry.set(name, plugin);
  }
}

/**
 * Returns a sorted list of all registered built-in plugin names and aliases.
 * Used for error messages and testing.
 */
export function listBuiltinPlugins(): string[] {
  return Array.from(builtinRegistry.keys()).sort();
}

/**
 * TEST ONLY: Clears all registered built-in plugins. Use in test afterEach
 * to ensure test isolation.
 */
export function __resetBuiltinPluginsForTests(): void {
  builtinRegistry.clear();
}

/**
 * Dynamically imports a plugin package by name (as configured in relay.yml's
 * `plugins[].module`) and validates it conforms to RelayPlugin. Accepts
 * either a default export or a named `plugin` export.
 *
 * First checks the built-in plugin registry (by exact match on name or alias).
 * If found, returns the registered plugin without any import. Otherwise,
 * attempts a dynamic import.
 * @throws with a descriptive error including the module name, original cause, and built-in list
 */
export async function loadPlugin(moduleName: string): Promise<RelayPlugin> {
  // Check built-in registry first
  const registered = builtinRegistry.get(moduleName);
  if (registered) {
    return registered;
  }

  // Dynamic import
  try {
    const mod = (await import(moduleName)) as Record<string, unknown>;
    const candidate = mod.default ?? mod.plugin ?? mod;
    if (!isRelayPlugin(candidate)) {
      throw new Error(
        `[queue-relay-client] Module "${moduleName}" does not export a valid RelayPlugin ` +
        `(expected a default or "plugin" export shaped { source: string, mapEvent: function }).`
      );
    }
    return candidate;
  } catch (err) {
    const builtinList = listBuiltinPlugins();
    const builtinDesc = builtinList.length > 0 ? builtinList.join(', ') : 'none';
    const originalMessage = getErrorMessage(err);
    const newError = new Error(
      `Cannot load relay plugin module "${moduleName}": ${originalMessage}. ` +
      `Built-in plugins: ${builtinDesc}. ` +
      `For an external plugin, use an absolute path or install the package next to the queue CLI.`
    );
    newError.cause = err;
    throw newError;
  }
}
