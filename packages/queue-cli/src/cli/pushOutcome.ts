import type { PushResponse } from '@wadeck-app/queue-core';

/** The stderr line for a push that did not go through, or null when it did. `action` is how the command names it ("Event", "Replay"). */
export function pushFailure(response: PushResponse, action: 'Event' | 'Replay'): string | null {
  if (response.status === 'aborted') {
    return `[queue] ${action} aborted: ${response.reason ?? 'unknown reason'}`;
  }
  if (response.status === 'rejected') {
    const accepted = response.supported ? ` The daemon accepts clients ${response.supported}.` : '';
    return `[queue] ${action} rejected (nothing was recorded): ${response.reason ?? 'unknown reason'}.${accepted} Update queue-cli so the CLI and the daemon agree.`;
  }
  return null;
}
