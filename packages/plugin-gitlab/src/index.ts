// violations-suppress: ts/no-barrel-index package entry point (package.json main/types): its exports are the package's public API, deleting it would expose dist internals to every consumer
import type { RelayPlugin, RelayEnvelope } from '@wadeck-app/queue-relay-client';
import { summarizeGitlabPayload } from './summarize.js';

/**
 * The entire GitLab-specific surface of this integration. queue-relay-client
 * knows nothing about GitLab -- this file is the one place that does.
 * Maps a relay envelope (eventType = the relay's name for the GitLab event,
 * e.g. "issue", "merge_request", "push") to a Queue event "on.gitlab.<eventType>",
 * passing the raw GitLab payload through unchanged.
 */
const plugin: RelayPlugin = {
  source: 'gitlab',
  mapEvent(envelope: RelayEnvelope) {
    // Return null to drop events without a valid non-empty string eventType.
    // The relay contract (RelayPlugin) treats null as "deliberately drop this event".
    if (typeof envelope.eventType !== 'string' || !envelope.eventType.trim()) {
      return null;
    }
    return {
      event: `on.gitlab.${envelope.eventType}`,
      payload: envelope.payload,
    };
  },
  summarize(_eventType, payload) {
    return summarizeGitlabPayload(payload);
  },
};

export default plugin;
