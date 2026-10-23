import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import { PROTOCOL_VERSION } from './protocol.js';

describe('public API', () => {
  it('exports exactly createQueuePublisher, PROTOCOL_VERSION and resolveConfigDir at runtime', () => {
    expect(Object.keys(api).sort()).toEqual(['PROTOCOL_VERSION', 'createQueuePublisher', 'resolveConfigDir']);
  });

  it('exports the protocol version the daemon is checked against', () => {
    expect(api.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  it('creates a publisher with the four documented methods', () => {
    const publisher = api.createQueuePublisher({ silent: true });
    expect(Object.keys(publisher).sort()).toEqual(['flush', 'publish', 'publishAndWait', 'status']);
  });

  it('exports the config dir resolution so a consumer finds the same directory the queue uses', () => {
    expect(api.resolveConfigDir({ QUEUE_CONFIG_DIR: '/x/queue' })).toBe('/x/queue');
  });
});
