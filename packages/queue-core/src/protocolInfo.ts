import { PROTOCOL_VERSION, DAEMON_ACCEPTS, type QueueProtocolInfo } from '@wadeck-app/queue-sdk/protocol';

/** What GET /version advertises as `queueProtocol`: the push protocol version this daemon implements and the client versions it accepts. */
export function getQueueProtocolInfo(): QueueProtocolInfo {
  return { version: PROTOCOL_VERSION, accepts: DAEMON_ACCEPTS };
}
