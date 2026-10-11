import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { pushEvent } from './push.js';
import { DaemonUnreachableError } from './errors.js';

beforeEach(() => {
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

describe('pushEvent', () => {
  it('throws DaemonUnreachableError when the daemon is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(pushEvent('/tmp/x', 'onFoo', { a: 1 })).rejects.toThrow(DaemonUnreachableError);
  });

  it('defaults cwd to process.cwd() and forwards the payload', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const response = await pushEvent('/tmp/x', 'onFoo', { a: 1 });
    expect(response).toEqual({ status: 'queued', eventId: 'e1' });
    expect(mockSend).toHaveBeenCalledWith('push', { event: 'onFoo', payload: { a: 1 }, cwd: process.cwd(), timeout: undefined });
  });

  it('uses an explicit cwd/timeout when provided', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'dispatched' });
    await pushEvent('/tmp/x', 'beforeFoo', { a: 1 }, { cwd: '/custom', timeout: 5000 });
    expect(mockSend).toHaveBeenCalledWith('push', { event: 'beforeFoo', payload: { a: 1 }, cwd: '/custom', timeout: 5000 });
  });
});
