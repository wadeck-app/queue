import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsRunning = vi.fn();
const mockSend = vi.fn();

vi.mock('@wadeck-app/queue-relay-client/dist/relayClient.js', () => ({
  createRelayClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
  relayStateDir: (dir: string) => `${dir}/relay-daemon`,
}));

import { getRelayInfo } from './relay.js';
import { RelayStatusError } from './errors.js';

beforeEach(() => {
  mockIsRunning.mockReset();
  mockSend.mockReset();
});

describe('getRelayInfo', () => {
  it('says stopped when the relay is not running, and asks nothing more', async () => {
    mockIsRunning.mockResolvedValue(false);
    const info = await getRelayInfo('/cfg');
    expect(info).toEqual({ state: 'stopped', label: 'Relay disconnected', tone: 'default', running: false, connected: false, pid: null, uptimeSec: null, lastError: null });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats a relay that cannot be asked as stopped, not as an error', async () => {
    mockIsRunning.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getRelayInfo('/cfg')).resolves.toMatchObject({ state: 'stopped' });
  });

  it('reports connected with the pid and uptime of the running relay', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ connected: true, pid: 4242, uptimeSec: 90, lastError: null });
    await expect(getRelayInfo('/cfg')).resolves.toEqual({
      state: 'connected', label: 'Relay connected', tone: 'success', running: true, connected: true, pid: 4242, uptimeSec: 90, lastError: null,
    });
    expect(mockSend).toHaveBeenCalledWith('status', undefined);
  });

  it('reports running but not connected, with the last error the relay gives', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ connected: false, pid: 7, uptimeSec: 3, lastError: 'ECONNREFUSED 127.0.0.1:1' });
    await expect(getRelayInfo('/cfg')).resolves.toMatchObject({
      state: 'not connected', label: 'Relay disconnected', tone: 'warning', running: true, connected: false, lastError: 'ECONNREFUSED 127.0.0.1:1',
    });
  });

  it('a relay that runs but does not answer its status throws RelayStatusError with the cause, what to do and its log (the route turns it into a JSON { error })', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockRejectedValue(new Error('socket hang up'));
    const error = await getRelayInfo('/cfg').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RelayStatusError);
    const message = (error as Error).message;
    expect(message).toContain('did not answer its status: socket hang up');
    expect(message).toContain('queue relay stop');
    expect(message).toContain('relay.log');
  });
});
