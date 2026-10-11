import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { DaemonUnreachableError } from './errors.js';

beforeEach(() => {
  mockSend.mockReset();
  mockIsRunning.mockReset();
});

describe('dlq operations', () => {
  it('listDlq throws DaemonUnreachableError when the daemon is not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    await expect(listDlq('/tmp/x')).rejects.toThrow(DaemonUnreachableError);
  });

  it('listDlq forwards entries from the daemon', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ entries: [{ id: 'd1' }] });
    expect(await listDlq('/tmp/x')).toEqual([{ id: 'd1' }]);
    expect(mockSend).toHaveBeenCalledWith('dlq-list', undefined);
  });

  it('replayDlqEntry sends the id', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ status: 'ok' });
    expect(await replayDlqEntry('/tmp/x', 'd1')).toEqual({ status: 'ok' });
    expect(mockSend).toHaveBeenCalledWith('dlq-replay', { id: 'd1' });
  });

  it('clearDlqEntry without an id clears all entries', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ cleared: 3 });
    expect(await clearDlqEntry('/tmp/x')).toEqual({ cleared: 3 });
    expect(mockSend).toHaveBeenCalledWith('dlq-clear', { id: undefined });
  });
});
