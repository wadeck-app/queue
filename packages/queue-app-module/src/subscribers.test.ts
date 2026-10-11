import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { listSubscribers } from './subscribers.js';
import { DaemonUnreachableError } from './errors.js';

beforeEach(() => {
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

describe('listSubscribers', () => {
  it('throws DaemonUnreachableError when the daemon is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(listSubscribers('/tmp/x', '/project')).rejects.toThrow(DaemonUnreachableError);
  });

  it('forwards the event filter and cwd, returning resolved subscribers', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ subscribers: [{ subscriberId: 'onFoo[0]' }] });
    const result = await listSubscribers('/tmp/x', '/project', 'onFoo');
    expect(result).toEqual([{ subscriberId: 'onFoo[0]' }]);
    expect(mockSend).toHaveBeenCalledWith('list-subscribers', { event: 'onFoo', cwd: '/project' });
  });
});
