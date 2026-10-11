import { describe, it, expect, vi } from 'vitest';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { getStatus } from './status.js';

describe('getStatus', () => {
  it('reports daemonRunning: false with zero counts when the daemon is unreachable', async () => {
    mockIsRunning.mockResolvedValue(false);
    const status = await getStatus('/tmp/whatever');
    expect(status).toEqual({ daemonRunning: false, pendingCount: 0, dlqCount: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('reports daemonRunning: false when isRunning rejects', async () => {
    mockIsRunning.mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await getStatus('/tmp/whatever');
    expect(status.daemonRunning).toBe(false);
  });

  it('forwards the daemon status response when running', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ pendingCount: 3, dlqCount: 1, daemonRunning: true, uptimeSec: 120, pid: 4242 });
    const status = await getStatus('/tmp/whatever');
    expect(status).toEqual({ daemonRunning: true, pendingCount: 3, dlqCount: 1, uptimeSec: 120, pid: 4242 });
    expect(mockSend).toHaveBeenCalledWith('status', undefined);
  });
});
