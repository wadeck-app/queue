import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, DAEMON_ACCEPTS } from '@wadeck-app/queue-sdk/protocol';
import { getQueueProtocolInfo } from './protocolInfo.js';

describe('getQueueProtocolInfo (what GET /version advertises as queueProtocol)', () => {
  it('is the protocol version the daemon implements and the client versions it accepts, both from the SDK constants', () => {
    expect(getQueueProtocolInfo()).toEqual({ version: PROTOCOL_VERSION, accepts: DAEMON_ACCEPTS });
  });
});
