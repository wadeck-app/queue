import type { PushResponse } from '@wadeck-app/queue-core';

/** The relay log line for the daemon's answer to a push: a failure line says the event was NOT delivered and where to look. */
export function pushLogLine({ event, deliveryId, result, configDir }: { event: string; deliveryId: string; result: PushResponse; configDir: string }): string {
  if (result.status === 'aborted') {
    return (
      `[relay] Push of "${event}" (delivery ${deliveryId}) was ABORTED by the queue daemon: ${result.reason ? result.reason : 'no reason given'}. ` +
      `The event was not delivered; check subscribers.yml and the daemon logs in ${configDir}/logs.`
    );
  }
  if (result.status === 'rejected') {
    return (
      `[relay] Push of "${event}" (delivery ${deliveryId}) was REJECTED by the queue daemon, nothing was recorded: ${result.reason ?? 'no reason given'}. ` +
      `The daemon accepts clients ${result.supported ?? 'of another protocol version'}; update the relay client and queue-cli so they agree.`
    );
  }
  // 'dispatched', 'queued' and any other status keep the success line
  return `[relay] Pushed "${event}" (delivery ${deliveryId}) -> ${result.status}.`;
}
