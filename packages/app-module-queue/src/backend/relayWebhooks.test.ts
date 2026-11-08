import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadRelayConfig, mockListWebhookConfigs, mockListDeliveries, mockCreateApi } = vi.hoisted(() => ({
  mockLoadRelayConfig: vi.fn(),
  mockListWebhookConfigs: vi.fn(),
  mockListDeliveries: vi.fn(),
  mockCreateApi: vi.fn(),
}));

vi.mock('@wadeck-app/queue-relay-client/dist/config.js', () => ({ loadRelayConfig: mockLoadRelayConfig }));
vi.mock('@wadeck-app/queue-relay-client/dist/relayApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wadeck-app/queue-relay-client/dist/relayApi.js')>()),
  createRelayApiClient: mockCreateApi,
}));

import { listWebhooks, listDeliveries, MAX_DELIVERY_LIMIT } from './relayWebhooks.js';
import { InvalidQueryError, RelayNotConfiguredError } from './errors.js';

const CONFIG = { relayUrl: 'wss://relay.example.test/relay-ws', token: 'super-secret-token', plugins: [] };

beforeEach(() => {
  mockLoadRelayConfig.mockReset().mockReturnValue(CONFIG);
  mockListWebhookConfigs.mockReset();
  mockListDeliveries.mockReset();
  mockCreateApi.mockReset().mockReturnValue({ listWebhookConfigs: mockListWebhookConfigs, listDeliveries: mockListDeliveries });
});

describe('listWebhooks', () => {
  it('lists the webhooks with their full payload URL and 24 h health, and never leaks the token', async () => {
    mockListWebhookConfigs.mockResolvedValue([
      { id: 'cfg-1', source: 'github', name: 'queue', createdAt: '2026-10-01T00:00:00Z', webhookUrl: '/hooks/abc', stats: { verified24h: 5, rejected24h: 1, lastDeliveryAt: '2026-10-19T10:00:00Z', lastVerifiedAt: null } },
      { id: 'cfg-2', source: 'github', name: 'old', createdAt: '2026-09-01T00:00:00Z', webhookUrl: '/hooks/def' },
    ]);
    const result = await listWebhooks('/cfg');
    expect(result.webhooks).toEqual([
      { id: 'cfg-1', source: 'github', name: 'queue', createdAt: '2026-10-01T00:00:00Z', payloadUrl: 'https://relay.example.test/hooks/abc', verified24h: 5, rejected24h: 1, lastDeliveryAt: '2026-10-19T10:00:00Z' },
      { id: 'cfg-2', source: 'github', name: 'old', createdAt: '2026-09-01T00:00:00Z', payloadUrl: 'https://relay.example.test/hooks/def', verified24h: null, rejected24h: null, lastDeliveryAt: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(mockCreateApi).toHaveBeenCalledWith({ relayUrl: CONFIG.relayUrl, token: CONFIG.token });
  });

  it('says what to create when there is no relay.yml', async () => {
    mockLoadRelayConfig.mockReturnValue(null);
    await expect(listWebhooks('/cfg')).rejects.toThrowError(RelayNotConfiguredError);
    await expect(listWebhooks('/cfg')).rejects.toThrowError(/No relay\.yml in \/cfg.*relayUrl/);
  });

  it.each([
    ['missing token', 'No relay token found. Put QUEUE_RELAY_TOKEN in _secrets_/.env.local'],
    ['bad yaml', '[queue-relay-client] Failed to parse YAML at /cfg/relay.yml: bad indentation. Fix the YAML syntax and retry.'],
  ])('a configuration error (%s) is a RelayNotConfiguredError (503, like a missing relay.yml) that keeps its own message', async (_name, message) => {
    mockLoadRelayConfig.mockImplementation(() => { throw new Error(message); });
    await expect(listWebhooks('/cfg')).rejects.toThrowError(RelayNotConfiguredError);
    await expect(listWebhooks('/cfg')).rejects.toThrowError(message);
    await expect(listDeliveries('/cfg', {})).rejects.toThrowError(RelayNotConfiguredError);
  });
});

describe('listDeliveries', () => {
  const delivery = (over: object) => ({ receivedAt: '2026-10-19T10:00:00Z', source: 'github', webhookConfigId: 'cfg-1', eventType: 'push', deliveryId: 'd1', verified: true, payload: { repository: { full_name: 'org/repo' } }, ...over });

  it('describes a verified delivery with its plugin, a rejected one with its reason, and drops the payload', async () => {
    mockListDeliveries.mockResolvedValue([delivery({}), delivery({ verified: false, error: 'Signature mismatch', payload: null })]);
    const { deliveries } = await listDeliveries('/cfg', {});
    expect(deliveries).toEqual([
      { receivedAt: '2026-10-19T10:00:00Z', source: 'github', eventType: 'push', status: 'verified', summary: 'org/repo' },
      { receivedAt: '2026-10-19T10:00:00Z', source: 'github', eventType: 'push', status: 'rejected', summary: 'Signature mismatch' },
    ]);
    expect(JSON.stringify(deliveries)).not.toContain('payload');
  });

  it('describes a GitLab delivery with the GitLab plugin', async () => {
    mockListDeliveries.mockResolvedValue([
      delivery({ source: 'gitlab', eventType: 'issue', payload: { project: { path_with_namespace: 'g/p' }, user: { username: 'wadeck' } } }),
    ]);
    const { deliveries } = await listDeliveries('/cfg', {});
    expect(deliveries[0]).toMatchObject({ source: 'gitlab', eventType: 'issue', status: 'verified', summary: 'g/p | by wadeck' });
  });

  it('asks for 20 deliveries with their payload (to describe them) by default', async () => {
    mockListDeliveries.mockResolvedValue([]);
    await listDeliveries('/cfg', {});
    expect(mockListDeliveries).toHaveBeenCalledWith({ limit: 20, eventType: undefined, source: undefined, verified: undefined, includePayload: true });
  });

  it('forwards the filters: event, source and status', async () => {
    mockListDeliveries.mockResolvedValue([]);
    await listDeliveries('/cfg', { limit: '5', event: 'push', source: 'github', status: 'rejected' });
    expect(mockListDeliveries).toHaveBeenCalledWith({ limit: 5, eventType: 'push', source: 'github', verified: false, includePayload: true });
    await listDeliveries('/cfg', { status: 'verified' });
    expect(mockListDeliveries).toHaveBeenLastCalledWith(expect.objectContaining({ verified: true }));
  });

  it.each([
    [{ limit: '0' }, /limit must be an integer between 1 and 200/],
    [{ limit: String(MAX_DELIVERY_LIMIT + 1) }, /limit must be an integer between 1 and 200/],
    [{ status: 'ok' }, /status must be "verified" or "rejected", got: "ok"/],
    [{ event: ['a', 'b'] }, /event must be given once/],
  ])('rejects %j before asking the relay anything', async (query, message) => {
    await expect(listDeliveries('/cfg', query)).rejects.toThrowError(InvalidQueryError);
    await expect(listDeliveries('/cfg', query)).rejects.toThrowError(message);
    expect(mockListDeliveries).not.toHaveBeenCalled();
  });
});
