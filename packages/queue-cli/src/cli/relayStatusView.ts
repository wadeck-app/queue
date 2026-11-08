import { getErrorMessage } from '@wadeck-app/queue-core';
import type { RelayStatus } from '@wadeck-app/queue-relay-client';

export function formatUptime(sec: number): string {
  if (sec < 60) {
    return `${sec}s`;
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** The terminal form of `queue relay status` for a running relay: what it reports about its connection, and where its log is. */
export function relayStatusLines(response: RelayStatus, relayPort: number | undefined, logPath: string): string {
  const lines = [
    '[ok]  relay client: running',
    `      port:         ${relayPort ?? '?'}`,
    `      connected:    ${response.connected ? 'yes' : 'no'}`,
    `      uptime:       ${formatUptime(response.uptimeSec)}`,
    `      pid:          ${response.pid}`,
  ];
  if (response.lastError !== null) {
    lines.push(`      last error:   ${response.lastError}${response.lastErrorAt !== null ? ` (${response.lastErrorAt})` : ''}`);
  }
  if (response.lastCloseCode !== null) {
    lines.push(`      close code:   ${response.lastCloseCode}`);
  }
  if (response.logError !== null) {
    lines.push(`      log error:    ${response.logError}`);
  }
  lines.push(`      log:          ${logPath}`);
  return lines.join('\n') + '\n';
}

/** Raised when a daemon that answers `isRunning` does not answer a command; the message says what to do. */
export class StatusUnavailableError extends Error {}

/** Runs a status request; a failure (a hung or half-dead daemon times out after 5 s) becomes a message with the cause and the fix, not a generic fatal error. */
export async function fetchStatus<T>(send: () => Promise<T>, who: string, fix: string): Promise<T> {
  try {
    return await send();
  } catch (err) {
    throw new StatusUnavailableError(`${who} is running but did not answer its status: ${getErrorMessage(err)}. Fix: ${fix}.`);
  }
}
