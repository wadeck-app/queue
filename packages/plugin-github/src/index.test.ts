import { describe, it, expect } from 'vitest';
import type { RelayEnvelope } from '@wadeck-app/queue-relay-client';
import plugin from './index.js';

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    source: 'github',
    webhookConfigId: 'wc1',
    eventType: 'pull_request',
    receivedAt: new Date().toISOString(),
    deliveryId: 'd1',
    payload: { action: 'opened' },
    headers: {},
    ...overrides,
  };
}

describe('plugin-github', () => {
  it('declares source "github"', () => {
    expect(plugin.source).toBe('github');
  });

  it('maps eventType to on.github.<eventType> and passes the payload through unchanged', () => {
    const envelope = makeEnvelope({ eventType: 'pull_request', payload: { action: 'opened', number: 42 } });
    expect(plugin.mapEvent(envelope)).toEqual({
      event: 'on.github.pull_request',
      payload: { action: 'opened', number: 42 },
    });
  });

  it('maps a different eventType correctly', () => {
    const envelope = makeEnvelope({ eventType: 'push' });
    expect(plugin.mapEvent(envelope)?.event).toBe('on.github.push');
  });

  it('returns null when eventType is null', () => {
    const envelope = makeEnvelope({ eventType: null as any });
    expect(plugin.mapEvent(envelope)).toBeNull();
  });

  it('returns null when eventType is undefined', () => {
    const envelope = makeEnvelope({ eventType: undefined as any });
    expect(plugin.mapEvent(envelope)).toBeNull();
  });

  it('returns null when eventType is an empty string', () => {
    const envelope = makeEnvelope({ eventType: '' });
    expect(plugin.mapEvent(envelope)).toBeNull();
  });

  it('returns null when eventType is a non-string value', () => {
    const envelope = makeEnvelope({ eventType: 123 as unknown as string });
    expect(plugin.mapEvent(envelope)).toBeNull();
  });

  it('returns null when eventType is a whitespace-only string', () => {
    const envelope = makeEnvelope({ eventType: '   ' });
    expect(plugin.mapEvent(envelope)).toBeNull();
  });
});
