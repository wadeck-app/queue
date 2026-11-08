import { describe, it, expect } from 'vitest';
import type { RelayEnvelope } from '@wadeck-app/queue-relay-client';
import plugin from './index.js';

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    source: 'gitlab',
    webhookConfigId: 'wc1',
    eventType: 'merge_request',
    receivedAt: new Date().toISOString(),
    deliveryId: 'd1',
    payload: { object_kind: 'merge_request' },
    headers: {},
    ...overrides,
  };
}

describe('plugin-gitlab', () => {
  it('declares source "gitlab"', () => {
    expect(plugin.source).toBe('gitlab');
  });

  it('maps eventType to on.gitlab.<eventType> and passes the payload through unchanged', () => {
    const payload = { object_kind: 'issue', object_attributes: { iid: 3, action: 'open' } };
    expect(plugin.mapEvent(makeEnvelope({ eventType: 'issue', payload }))).toEqual({ event: 'on.gitlab.issue', payload });
  });

  it('keeps the eventType as the relay gives it, underscores included (tag_push)', () => {
    expect(plugin.mapEvent(makeEnvelope({ eventType: 'tag_push' }))?.event).toBe('on.gitlab.tag_push');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a number', 123],
  ])('drops the delivery when eventType is %s', (_label, eventType) => {
    expect(plugin.mapEvent(makeEnvelope({ eventType: eventType as unknown as string }))).toBeNull();
  });

  it('describes a delivery through summarize', () => {
    const summary = plugin.summarize?.('issue', { project: { path_with_namespace: 'g/p' }, user: { username: 'wadeck' } });
    expect(summary).toBe('g/p | by wadeck');
  });
});
