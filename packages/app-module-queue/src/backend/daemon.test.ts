import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsRunning = vi.fn();

vi.mock('./client.js', () => ({
  createQueueAppClient: vi.fn(() => ({ isRunning: mockIsRunning })),
}));

import { getDaemonState, DAEMON_DOWN_HINT } from './daemon.js';

beforeEach(() => {
  mockIsRunning.mockReset();
});

describe('getDaemonState', () => {
  it('has no hint while the daemon runs', async () => {
    mockIsRunning.mockResolvedValue(true);
    await expect(getDaemonState('/cfg')).resolves.toEqual({ running: true, hint: null });
  });

  it('tells what to do when the daemon is down', async () => {
    mockIsRunning.mockResolvedValue(false);
    const state = await getDaemonState('/cfg');
    expect(state).toEqual({ running: false, hint: DAEMON_DOWN_HINT });
    expect(state.hint).toContain('queue start');
  });

  it('treats a daemon that cannot be asked as down, not as an error', async () => {
    mockIsRunning.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getDaemonState('/cfg')).resolves.toMatchObject({ running: false });
  });
});
