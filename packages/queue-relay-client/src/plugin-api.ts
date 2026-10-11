/**
 * Contract every relay plugin package implements. This module owns the
 * contract only -- it must never import or reference anything Source-specific
 * (no "github", "slack", "jira", ...). That belongs exclusively in the plugin
 * packages themselves (e.g. @wadeck-app/plugin-github). queue-relay-client is
 * shared infrastructure used BY every plugin; it is not a plugin itself.
 */

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

/**
 * Dynamically imports a plugin package by name (as configured in relay.yml's
 * `plugins[].module`) and validates it conforms to RelayPlugin. Accepts
 * either a default export or a named `plugin` export.
 */
export async function loadPlugin(moduleName: string): Promise<RelayPlugin> {
  const mod = (await import(moduleName)) as Record<string, unknown>;
  const candidate = mod.default ?? mod.plugin ?? mod;
  if (!isRelayPlugin(candidate)) {
    throw new Error(
      `[queue-relay-client] Module "${moduleName}" does not export a valid RelayPlugin ` +
      `(expected a default or "plugin" export shaped { source: string, mapEvent: function }).`
    );
  }
  return candidate;
}
