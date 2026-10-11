import type { RelayPlugin } from '../plugin-api.js';

const plugin: RelayPlugin = {
  source: 'fixture-source',
  mapEvent: (envelope) => ({ event: `on.fixture-source.${envelope.eventType}`, payload: envelope.payload }),
};

export default plugin;
