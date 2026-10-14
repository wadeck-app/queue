import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { getErrorMessage } from '@wadeck-app/queue-core';

const SubscriptionConfigSchema = z.object({
  eventType: z.array(z.string()).optional(),
  payloadMatch: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** Overrides the plugin's own mapEvent-derived event name when set. */
  queueEvent: z.string().nullable().optional(),
});

const PluginConfigSchema = z.object({
  /** Package name to dynamically import, e.g. "@wadeck-app/plugin-github". */
  module: z.string().min(1),
  subscriptions: z.array(SubscriptionConfigSchema).min(1),
});

// Validate relayUrl: must be wss://, or ws:// with localhost/127.0.0.1/[::1]
// Returns the validation result and error message if invalid
function validateRelayUrl(url: string): { valid: boolean; message?: string } {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol;
    const hostname = parsed.hostname;

    // Allow wss:// for any hostname
    if (protocol === 'wss:') {
      return { valid: true };
    }

    // Allow ws:// only for localhost, 127.0.0.1, or [::1]
    if (protocol === 'ws:') {
      // URL.hostname includes brackets for IPv6, so check for '[::1]' as well
      const isLocalhost =
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
      if (isLocalhost) {
        return { valid: true };
      }
      return {
        valid: false,
        message: `relayUrl must use wss:// (the relay token is sent as the first message and would travel in clear over ws://); ws:// is only accepted for localhost. Got: ${url}`,
      };
    }

    // Reject all other protocols
    return {
      valid: false,
      message: `relayUrl must use wss:// (the relay token is sent as the first message and would travel in clear over ws://); ws:// is only accepted for localhost. Got: ${url}`,
    };
  } catch {
    // Invalid URL
    return {
      valid: false,
      message: `relayUrl must use wss:// (the relay token is sent as the first message and would travel in clear over ws://); ws:// is only accepted for localhost. Got: ${url}`,
    };
  }
}

export const RelayConfigSchema = z.object({
  relayUrl: z
    .string()
    .url()
    .superRefine((url, ctx) => {
      const result = validateRelayUrl(url);
      if (!result.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.message!,
        });
      }
    }),
  token: z.string().min(1),
  plugins: z.array(PluginConfigSchema).default([]),
});

export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type SubscriptionConfig = z.infer<typeof SubscriptionConfigSchema>;

/** Re-read every time, same "no caching, no file-watcher" philosophy ConfigLoader.ts uses for subscribers.yml. */
export function loadRelayConfig(configDir: string): RelayConfig | null {
  const filePath = join(configDir, 'relay.yml');
  if (!existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = yamlLoad(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `[queue-relay-client] Failed to parse YAML at ${filePath}: ${getErrorMessage(err)}\n` +
      `Fix the YAML syntax and retry.`
    );
  }

  const result = RelayConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[queue-relay-client] Invalid relay.yml at ${filePath}:\n${result.error.toString()}\n` +
      `Expected { relayUrl, token, plugins: [{ module, subscriptions: [{ eventType?, payloadMatch?, queueEvent? }] }] }.`
    );
  }
  return result.data;
}
