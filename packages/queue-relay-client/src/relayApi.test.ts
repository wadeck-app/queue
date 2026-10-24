import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRelayApiClient, RelayApiError, summarizePayload } from './relayApi.js';
import type { RelayPlugin } from './plugin-api.js';
import { getErrorMessage } from '@wadeck-app/queue-core';

interface MockFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

describe('relayApi', () => {
  describe('httpBaseFromRelayUrl', () => {
    it('converts wss:// to https://', async () => {
      const { httpBaseFromRelayUrl } = await import('./relayApi.js');
      expect(httpBaseFromRelayUrl('wss://relay.example.com/relay-ws')).toBe('https://relay.example.com');
    });

    it('converts wss:// with port to https://', async () => {
      const { httpBaseFromRelayUrl } = await import('./relayApi.js');
      expect(httpBaseFromRelayUrl('wss://relay.example.com:9000/relay-ws')).toBe('https://relay.example.com:9000');
    });

    it('converts ws:// to http://', async () => {
      const { httpBaseFromRelayUrl } = await import('./relayApi.js');
      expect(httpBaseFromRelayUrl('ws://localhost:3000/relay-ws')).toBe('http://localhost:3000');
    });

    it('converts ws:// with port to http://', async () => {
      const { httpBaseFromRelayUrl } = await import('./relayApi.js');
      expect(httpBaseFromRelayUrl('ws://127.0.0.1:8080/relay-ws')).toBe('http://127.0.0.1:8080');
    });

    it('preserves path-less URLs', async () => {
      const { httpBaseFromRelayUrl } = await import('./relayApi.js');
      expect(httpBaseFromRelayUrl('wss://relay.example.com')).toBe('https://relay.example.com');
    });
  });

  describe('createRelayApiClient', () => {
    let mockFetch: any;
    let client: any;

    beforeEach(() => {
      mockFetch = vi.fn();
      client = createRelayApiClient({
        relayUrl: 'wss://relay.example.com:9000/relay-ws',
        token: 'test-token-12345',
        fetch: mockFetch,
        timeoutMs: 5000,
      });
    });

    describe('listWebhookConfigs', () => {
      it('makes a GET request with Authorization header to /api/webhook-configs', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            configs: [
              {
                id: 'cfg-1',
                source: 'github',
                name: 'My Webhook',
                createdAt: '2026-10-01T00:00:00Z',
                webhookUrl: '/webhook/github/cfg-1',
                stats: {
                  verified24h: 10,
                  rejected24h: 0,
                  lastDeliveryAt: '2026-10-14T10:00:00Z',
                  lastVerifiedAt: '2026-10-14T10:00:00Z',
                },
              },
            ],
          }),
        });

        const configs = await client.listWebhookConfigs();

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toBe('https://relay.example.com:9000/api/webhook-configs');
        expect(callArgs[1].method).toBe('GET');
        expect(callArgs[1].headers['Authorization']).toBe('Bearer test-token-12345');

        expect(configs).toHaveLength(1);
        expect(configs[0]).toEqual({
          id: 'cfg-1',
          source: 'github',
          name: 'My Webhook',
          createdAt: '2026-10-01T00:00:00Z',
          webhookUrl: '/webhook/github/cfg-1',
          stats: {
            verified24h: 10,
            rejected24h: 0,
            lastDeliveryAt: '2026-10-14T10:00:00Z',
            lastVerifiedAt: '2026-10-14T10:00:00Z',
          },
        });
      });

      it('returns empty array when no configs', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            configs: [],
          }),
        });

        const configs = await client.listWebhookConfigs();
        expect(configs).toEqual([]);
      });

      it('throws RelayApiError with 401 and kind unauthorized', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 401,
          ok: false,
          text: async () => 'Unauthorized',
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.status).toBe(401);
          expect(err.kind).toBe('unauthorized');
          expect(getErrorMessage(err)).toContain('The relay refused the token');
          expect(getErrorMessage(err)).not.toContain('test-token-12345');
        }
      });

      it('throws RelayApiError with 403 and kind unauthorized', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 403,
          ok: false,
          text: async () => 'Forbidden',
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.status).toBe(403);
          expect(err.kind).toBe('unauthorized');
        }
      });

      it('throws RelayApiError with 429 and kind blocked', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 429,
          ok: false,
          text: async () => 'Too Many Requests',
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.status).toBe(429);
          expect(err.kind).toBe('blocked');
          expect(getErrorMessage(err)).toContain('HTTP 429');
        }
      });

      it('throws RelayApiError with 5xx and kind server', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 503,
          ok: false,
          text: async () => 'Service Unavailable',
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.status).toBe(503);
          expect(err.kind).toBe('server');
        }
      });

      it('throws RelayApiError with network error and kind network', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED: Connection refused'));

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.kind).toBe('network');
          expect(getErrorMessage(err)).toContain('Cannot reach the relay');
          expect(getErrorMessage(err)).not.toContain('test-token-12345');
        }
      });

      it('throws RelayApiError with timeout', async () => {
        mockFetch.mockImplementation(async (url: string, opts: MockFetchOptions) => {
          // Simulate abort by throwing when signal is triggered
          if (opts.signal) {
            // Wait for abort
            return new Promise((_, reject) => {
              opts.signal?.addEventListener('abort', () => {
                const error = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
                reject(error);
              });
            });
          }
          return new Promise(() => {}); // Never resolves
        });

        const timeoutClient = createRelayApiClient({
          relayUrl: 'wss://relay.example.com/relay-ws',
          token: 'test-token-12345',
          fetch: mockFetch,
          timeoutMs: 50,
        });

        try {
          await timeoutClient.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.kind).toBe('timeout');
          expect(getErrorMessage(err)).toContain('did not answer within');
        }
      });

      it('throws RelayApiError with protocol error when JSON is invalid', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          },
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.kind).toBe('protocol');
        }
      });

      it('throws RelayApiError with protocol error when response shape is wrong', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            // Missing 'success' field
            serverTime: '2026-10-14T00:00:00Z',
          }),
        });

        try {
          await client.listWebhookConfigs();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.kind).toBe('protocol');
          expect(getErrorMessage(err)).toContain('Unexpected response');
          expect(getErrorMessage(err)).toContain('success');
        }
      });
    });

    describe('listDeliveries', () => {
      it('makes a GET request with query params and Authorization header', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            entries: [
              {
                receivedAt: '2026-10-14T10:00:00Z',
                source: 'github',
                webhookConfigId: 'cfg-1',
                eventType: 'push',
                deliveryId: 'del-1',
                verified: true,
                payload: { repository: { full_name: 'org/repo' } },
              },
            ],
          }),
        });

        const deliveries = await client.listDeliveries({
          limit: 20,
          eventType: 'push',
          source: 'github',
          verified: true,
          includePayload: true,
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        const url = new URL(callArgs[0]);
        expect(url.origin).toBe('https://relay.example.com:9000');
        expect(url.pathname).toBe('/api/webhook-history');
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('eventType')).toBe('push');
        expect(url.searchParams.get('source')).toBe('github');
        expect(url.searchParams.get('verified')).toBe('true');
        expect(url.searchParams.get('includePayload')).toBe('1');
        expect(callArgs[1].headers['Authorization']).toBe('Bearer test-token-12345');

        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].eventType).toBe('push');
      });

      it('returns empty array when no deliveries', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            entries: [],
          }),
        });

        const deliveries = await client.listDeliveries();
        expect(deliveries).toEqual([]);
      });

      it('omits optional query params when not provided', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            entries: [],
          }),
        });

        await client.listDeliveries({});

        const callArgs = mockFetch.mock.calls[0];
        const url = new URL(callArgs[0]);
        expect(url.searchParams.has('limit')).toBe(false);
        expect(url.searchParams.has('eventType')).toBe(false);
        expect(url.searchParams.has('source')).toBe(false);
        expect(url.searchParams.has('verified')).toBe(false);
        expect(url.searchParams.has('includePayload')).toBe(false);
      });

      it('includes deliveries with null payload when includePayload is false', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            serverTime: '2026-10-14T00:00:00Z',
            entries: [
              {
                receivedAt: '2026-10-14T10:00:00Z',
                source: 'github',
                webhookConfigId: 'cfg-1',
                eventType: 'push',
                deliveryId: 'del-1',
                verified: false,
                error: 'Signature mismatch',
                payload: null,
              },
            ],
          }),
        });

        const deliveries = await client.listDeliveries();
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].payload).toBeNull();
        expect(deliveries[0].error).toBe('Signature mismatch');
      });

      it('throws RelayApiError with protocol error when response shape is wrong', async () => {
        mockFetch.mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            success: true,
            // Missing 'entries' field
            serverTime: '2026-10-14T00:00:00Z',
          }),
        });

        try {
          await client.listDeliveries();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err).toBeInstanceOf(RelayApiError);
          expect(err.kind).toBe('protocol');
          expect(getErrorMessage(err)).toContain('entries');
        }
      });
    });
  });
});

describe('summarizePayload (generic: the plugin of the source writes the summary)', () => {
  const plugin = (summary: string | null): RelayPlugin => ({
    source: 'demo',
    mapEvent: () => null,
    summarize: () => summary,
  });

  it('returns what the plugin of that source says', () => {
    expect(summarizePayload([plugin('hello')], 'demo', 'x', { a: 1 })).toBe('hello');
  });

  it('reads "(no summary)" when no plugin handles the source', () => {
    expect(summarizePayload([plugin('hello')], 'other', 'x', { a: 1 })).toBe('(no summary)');
    expect(summarizePayload([], 'demo', 'x', { a: 1 })).toBe('(no summary)');
  });

  it('reads "(no summary)" when the plugin has no summarize, says nothing, or the payload is not an object', () => {
    expect(summarizePayload([{ source: 'demo', mapEvent: () => null }], 'demo', 'x', { a: 1 })).toBe('(no summary)');
    expect(summarizePayload([plugin(null)], 'demo', 'x', { a: 1 })).toBe('(no summary)');
    expect(summarizePayload([plugin('hello')], 'demo', 'x', null)).toBe('(no summary)');
    expect(summarizePayload([plugin('hello')], 'demo', 'x', undefined)).toBe('(no summary)');
  });

  it('caps a long summary at 110 characters, ending with "..."', () => {
    const summary = summarizePayload([plugin('x'.repeat(300))], 'demo', 'x', { a: 1 });
    expect(summary).toHaveLength(110);
    expect(summary.endsWith('...')).toBe(true);
  });
});
