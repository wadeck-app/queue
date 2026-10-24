import { createRelayClient } from '@wadeck-app/queue-relay-client/dist/relayClient.js';

export type RelayState = 'connected' | 'not connected' | 'stopped';

export interface RelayInfo {
  state: RelayState;
  /** The text of the navbar badge: the relay is either connected or it is not (stopped is a normal, on-demand state). */
  label: 'Relay connected' | 'Relay disconnected';
  /** The Badge variant of the dashboard for this state: stopped is normal (on demand), only a running relay that lost its connection is a warning. */
  tone: 'success' | 'warning' | 'default';
  running: boolean;
  connected: boolean;
  /** Only while the relay runs. */
  pid: number | null;
  uptimeSec: number | null;
  /** The last connection error the relay reports, if any. */
  lastError: string | null;
}

/** The state of the webhook relay client, as `queue relay status` reports it. Nothing is started: "stopped" is normal, the relay runs on demand. */
export async function getRelayInfo(configDir: string): Promise<RelayInfo> {
  const client = createRelayClient(configDir);
  const running = await client.isRunning().catch(() => false);
  if (!running) {
    return { state: 'stopped', label: 'Relay disconnected', tone: 'default', running: false, connected: false, pid: null, uptimeSec: null, lastError: null };
  }
  const status = await client.send('status', undefined);
  return {
    state: status.connected ? 'connected' : 'not connected',
    label: status.connected ? 'Relay connected' : 'Relay disconnected',
    tone: status.connected ? 'success' : 'warning',
    running: true,
    connected: status.connected,
    pid: status.pid,
    uptimeSec: status.uptimeSec,
    lastError: status.lastError,
  };
}
