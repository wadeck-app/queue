import type { RelayPlugin, RelayEnvelope } from '@wadeck-app/queue-relay-client';

/**
 * The entire GitHub-specific surface of this integration. queue-relay-client
 * knows nothing about GitHub -- this file is the one place that does.
 * Maps a relay envelope (eventType = GitHub's own event name, e.g.
 * "pull_request", "push") to a Queue event "on.github.<eventType>", passing
 * the raw GitHub payload through unchanged.
 */
const plugin: RelayPlugin = {
  source: 'github',
  mapEvent(envelope: RelayEnvelope) {
    return {
      event: `on.github.${envelope.eventType}`,
      payload: envelope.payload,
    };
  },
};

export default plugin;
