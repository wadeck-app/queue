import { describe, it, expect } from 'vitest';
import { createRelayApiClient } from './relayApi.js';

/** A relay whose answers are scripted by the URL asked: each call is recorded. */
function fakeRelay(answer: (url: URL) => Record<string, unknown>): { fetch: typeof globalThis.fetch; asked: URL[] } {
  const asked: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url);
    return new Response(JSON.stringify({ success: true, ...answer(url) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const entry = (deliveryId: string) => ({ receivedAt: '2026-11-23T20:00:00Z', source: 'github', webhookConfigId: 'w', eventType: 'workflow_run', deliveryId, verified: true });

describe('listDeliveriesSince', () => {
  it('sends repo, since, event, source and the payload flag, once when the relay answers for the whole period', async () => {
    const relay = fakeRelay(() => ({ entries: [entry('a')] }));
    const api = createRelayApiClient({ relayUrl: 'wss://relay.example/relay-ws', token: 't', fetch: relay.fetch });
    const entries = await api.listDeliveriesSince({ since: '2026-11-23T20:00:00.000Z', repo: 'wadeck-app/machine', eventType: 'workflow_run', source: 'github', includePayload: true, limit: 100 });
    expect(entries.map((one) => one.deliveryId)).toEqual(['a']);
    expect(relay.asked).toHaveLength(1);
    expect(Object.fromEntries(relay.asked[0]!.searchParams)).toEqual({ since: '2026-11-23T20:00:00.000Z', repo: 'wadeck-app/machine', eventType: 'workflow_run', source: 'github', includePayload: '1', limit: '100' });
  });

  it('across midnight (sinceBeforeDay) asks the earlier day it names with the same filters, and returns both, newest first', async () => {
    const relay = fakeRelay((url) => (url.searchParams.get('day') === '2026-11-22' ? { entries: [entry('yesterday')] } : { entries: [entry('today')], sinceBeforeDay: true, olderDay: '2026-11-22' }));
    const api = createRelayApiClient({ relayUrl: 'wss://relay.example/relay-ws', token: 't', fetch: relay.fetch });
    const entries = await api.listDeliveriesSince({ since: '2026-11-22T23:00:00.000Z', repo: 'wadeck-app/machine', eventType: 'workflow_run' });
    expect(entries.map((one) => one.deliveryId)).toEqual(['today', 'yesterday']);
    expect(relay.asked).toHaveLength(2);
    expect(relay.asked[1]!.searchParams.get('day')).toBe('2026-11-22');
    expect(relay.asked[1]!.searchParams.get('repo')).toBe('wadeck-app/machine');
    expect(relay.asked[1]!.searchParams.get('since')).toBe('2026-11-22T23:00:00.000Z');
  });
});
