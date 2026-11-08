/**
 * `queue relay status` / `queue status` on a terminal: what the relay reports about its connection is shown (it used to print only "connected: no"),
 * and a daemon that does not answer gives an actionable message instead of a generic "Fatal error".
 */
import { describe, it, expect } from 'vitest';
import { relayStatusLines, fetchStatus, StatusUnavailableError } from './relayStatusView.js';
import type { RelayStatus } from '@wadeck-app/queue-relay-client';

const LOG = '/cfg/relay-daemon/relay.log';

function status(overrides: Partial<RelayStatus> = {}): RelayStatus {
  return { connected: true, pid: 4242, uptimeSec: 75, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null, ...overrides };
}

describe('relayStatusLines', () => {
  it('a connected relay: the usual fields and where the log is, no error lines', () => {
    const text = relayStatusLines(status(), 47911, LOG);

    expect(text).toContain('[ok]  relay client: running');
    expect(text).toContain('connected:    yes');
    expect(text).toContain('port:         47911');
    expect(text).toContain('uptime:       1m 15s');
    expect(text).toContain('pid:          4242');
    expect(text).toContain(`log:          ${LOG}`);
    expect(text).not.toContain('last error');
    expect(text).not.toContain('close code');
    expect(text).not.toContain('log error');
  });

  it('a relay that is not connected says why: last error, when, close code, last error of the log, and where to look', () => {
    const text = relayStatusLines(
      status({ connected: false, lastError: 'Unexpected server response: 502', lastErrorAt: '2026-11-08T10:00:00.000Z', lastCloseCode: 1006, logError: 'frame is not JSON: <html>502' }),
      undefined,
      LOG,
    );

    expect(text).toContain('connected:    no');
    expect(text).toContain('port:         ?');
    expect(text).toContain('last error:   Unexpected server response: 502 (2026-11-08T10:00:00.000Z)');
    expect(text).toContain('close code:   1006');
    expect(text).toContain('log error:    frame is not JSON: <html>502');
    expect(text).toContain(`log:          ${LOG}`);
  });
});

describe('fetchStatus', () => {
  it('returns the answer', async () => {
    expect(await fetchStatus(async () => 'ok', 'the relay client', 'queue relay stop, then queue relay start')).toBe('ok');
  });

  it('turns a failed or timed-out request into a message that names the cause and the fix', async () => {
    const send = async (): Promise<never> => { throw new Error('HTTP timeout after 5s'); };

    const error = await fetchStatus(send, 'the relay client', 'queue relay stop, then queue relay start; its log is /cfg/relay.log').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StatusUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain('the relay client is running but did not answer its status');
    expect(message).toContain('HTTP timeout after 5s');
    expect(message).toContain('Fix: queue relay stop, then queue relay start; its log is /cfg/relay.log');
  });
});
