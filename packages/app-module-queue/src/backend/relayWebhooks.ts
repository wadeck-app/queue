import { loadRelayConfig } from '@wadeck-app/queue-relay-client/dist/config.js';
import { createRelayApiClient, httpBaseFromRelayUrl, summarizePayload } from '@wadeck-app/queue-relay-client/dist/relayApi.js';
import githubPlugin from '@wadeck-app/plugin-github';
import { InvalidQueryError, RelayNotConfiguredError } from './errors.js';
import { parseDigits, validateSingleString, type QueryParams } from './historyQuery.js';

export const DEFAULT_DELIVERY_LIMIT = 20;
export const MAX_DELIVERY_LIMIT = 200;

/** Which plugins describe the deliveries of their source: the same list as the CLI's built-in relay plugins. */
const PLUGINS = [githubPlugin];

export interface WebhookRow {
  id: string;
  source: string;
  name: string;
  createdAt: string;
  /** The full URL to give to the sender (relay origin + path). */
  payloadUrl: string;
  /** Absent on relays that do not report statistics. */
  verified24h: number | null;
  rejected24h: number | null;
  lastDeliveryAt: string | null;
}

export interface DeliveryRow {
  receivedAt: string;
  source: string;
  eventType: string;
  status: 'verified' | 'rejected';
  /** The rejection reason, or the plugin's one-line description of the payload. The payload itself is not returned. */
  summary: string;
}

/**
 * The remote relay's API client, built from relay.yml and the relay token (read here, never returned).
 * A missing relay.yml or token throws with what to do: an empty list would hide the mistake.
 */
function openRelayApi(configDir: string): { api: ReturnType<typeof createRelayApiClient>; origin: string } {
  const config = loadRelayConfig(configDir);
  if (config === null) {
    throw new RelayNotConfiguredError(
      `No relay.yml in ${configDir}. Create it with relayUrl: wss://<relay-host>/relay-ws and a plugins list (see "queue relay --help").`,
    );
  }
  return { api: createRelayApiClient({ relayUrl: config.relayUrl, token: config.token }), origin: httpBaseFromRelayUrl(config.relayUrl) };
}

/** `queue relay webhook list`: the webhooks configured on the relay with their last-24h health. Asks the remote relay. */
export async function listWebhooks(configDir: string): Promise<{ webhooks: WebhookRow[] }> {
  const { api, origin } = openRelayApi(configDir);
  const configs = await api.listWebhookConfigs();
  return {
    webhooks: configs.map((config) => ({
      id: config.id,
      source: config.source,
      name: config.name,
      createdAt: config.createdAt,
      payloadUrl: `${origin}${config.webhookUrl}`,
      verified24h: config.stats?.verified24h ?? null,
      rejected24h: config.stats?.rejected24h ?? null,
      lastDeliveryAt: config.stats?.lastDeliveryAt ?? null,
    })),
  };
}

function optionalString(query: QueryParams, name: string): string | undefined {
  const value = query[name];
  return value === undefined || value === '' ? undefined : validateSingleString(value, name);
}

/** `queue relay webhook history`: the latest deliveries the relay received, newest first. Asks the remote relay. */
export async function listDeliveries(configDir: string, query: QueryParams): Promise<{ deliveries: DeliveryRow[] }> {
  const limit = parseDigits(query['limit'], 'limit', {
    min: 1,
    max: MAX_DELIVERY_LIMIT,
    expected: `an integer between 1 and ${MAX_DELIVERY_LIMIT}`,
  }) ?? DEFAULT_DELIVERY_LIMIT;
  const eventType = optionalString(query, 'event');
  const source = optionalString(query, 'source');
  const status = optionalString(query, 'status');
  if (status !== undefined && status !== 'verified' && status !== 'rejected') {
    throw new InvalidQueryError(`status must be "verified" or "rejected", got: "${status}"`);
  }

  const { api } = openRelayApi(configDir);
  // The payload is requested to describe it, and dropped before answering
  const deliveries = await api.listDeliveries({ limit, eventType, source, verified: status === undefined ? undefined : status === 'verified', includePayload: true });
  return {
    deliveries: deliveries.map((delivery) => ({
      receivedAt: delivery.receivedAt,
      source: delivery.source,
      eventType: delivery.eventType,
      status: delivery.verified ? 'verified' : 'rejected',
      summary: !delivery.verified && delivery.error ? delivery.error : summarizePayload(PLUGINS, delivery.source, delivery.eventType, delivery.payload ?? undefined),
    })),
  };
}
