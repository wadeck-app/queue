import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { retryEvent } from './retry.js';
import { DaemonUnreachableError } from './errors.js';

beforeEach(() => {
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

describe('retryEvent', () => {
  it('asks the running daemon to retry the event and returns its answer', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok' });
    await expect(retryEvent('/cfg', 'wal-1')).resolves.toEqual({ status: 'ok' });
    expect(mockSend).toHaveBeenCalledWith('retry', { eventId: 'wal-1' });
  });

  it('passes a not-found answer through (the route turns it into a 404)', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'not-found' });
    await expect(retryEvent('/cfg', 'nope')).resolves.toEqual({ status: 'not-found' });
  });

  it('throws DaemonUnreachableError, naming the fix, when the daemon is down', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(retryEvent('/cfg', 'wal-1')).rejects.toThrowError(DaemonUnreachableError);
    await expect(retryEvent('/cfg', 'wal-1')).rejects.toThrowError(/queue start/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('treats an unanswerable daemon as down', async () => {
    mockIsRunning.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(retryEvent('/cfg', 'wal-1')).rejects.toThrowError(DaemonUnreachableError);
  });
});
