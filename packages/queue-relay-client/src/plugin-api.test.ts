import { describe, it, expect } from 'vitest';
import { loadPlugin, type RelayEnvelope } from './plugin-api.js';

describe('loadPlugin', () => {
  it('loads a valid default-exported plugin', async () => {
    const plugin = await loadPlugin('./fixtures/valid-plugin.js');
    expect(plugin.source).toBe('fixture-source');
    const envelope: RelayEnvelope = {
      source: 'fixture-source',
      webhookConfigId: 'wc1',
      eventType: 'ping',
      receivedAt: new Date().toISOString(),
      deliveryId: 'd1',
      payload: { hello: 'world' },
      headers: {},
    };
    expect(plugin.mapEvent(envelope)).toEqual({ event: 'on.fixture-source.ping', payload: { hello: 'world' } });
  });

  it('rejects a module that does not export a valid RelayPlugin', async () => {
    await expect(loadPlugin('./fixtures/invalid-plugin.js')).rejects.toThrow(/does not export a valid RelayPlugin/);
  });
});
