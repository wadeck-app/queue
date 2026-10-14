import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDaemonScript, spawnDaemon } from './spawnDaemon.js';
import * as queueCore from '@wadeck-app/queue-core';

// Mock the queue-core module's spawnDetachedProcess
vi.mock('@wadeck-app/queue-core', async () => {
  const actual = await vi.importActual('@wadeck-app/queue-core');
  return {
    ...actual,
    spawnDetachedProcess: vi.fn(),
  };
});

describe('resolveDaemonScript', () => {
  it('returns bundlePath when bundle exists', () => {
    const mockExistsSync = vi.fn().mockReturnValue(true);
    const result = resolveDaemonScript(
      { existsSync: mockExistsSync, bundlePath: '/path/to/queue-daemon.cjs', tscPath: '/path/to/daemon-entry.js' }
    );
    expect(result).toBe('/path/to/queue-daemon.cjs');
    expect(mockExistsSync).toHaveBeenCalledWith('/path/to/queue-daemon.cjs');
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it('returns tscPath when bundle does not exist', () => {
    const mockExistsSync = vi.fn().mockReturnValue(false);
    const result = resolveDaemonScript(
      { existsSync: mockExistsSync, bundlePath: '/path/to/queue-daemon.cjs', tscPath: '/path/to/daemon-entry.js' }
    );
    expect(result).toBe('/path/to/daemon-entry.js');
    expect(mockExistsSync).toHaveBeenCalledWith('/path/to/queue-daemon.cjs');
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it('prefers bundle over tsc when bundle exists', () => {
    const mockExistsSync = vi.fn().mockReturnValue(true);
    const result = resolveDaemonScript(
      { existsSync: mockExistsSync, bundlePath: '/priority/queue-daemon.cjs', tscPath: '/fallback/daemon-entry.js' }
    );
    expect(result).toBe('/priority/queue-daemon.cjs');
  });
});

describe('spawnDaemon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves bundle and calls spawnDetachedProcess with correct args', () => {
    const mockExistsSync = vi.fn().mockReturnValue(true);
    const mockSpawnDetached = vi.spyOn(queueCore, 'spawnDetachedProcess');

    spawnDaemon('/tmp/config-dir', {
      existsSync: mockExistsSync,
      bundlePath: '/app/queue-daemon.cjs',
      tscPath: '/fallback/daemon-entry.js',
    });

    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    expect(mockSpawnDetached).toHaveBeenCalledWith('/app/queue-daemon.cjs', { QUEUE_CONFIG_DIR: '/tmp/config-dir' });
  });

  it('resolves tsc path and calls spawnDetachedProcess when bundle missing', () => {
    const mockExistsSync = vi.fn().mockReturnValue(false);
    const mockSpawnDetached = vi.spyOn(queueCore, 'spawnDetachedProcess');

    spawnDaemon('/home/user/.queue', {
      existsSync: mockExistsSync,
      bundlePath: '/app/queue-daemon.cjs',
      tscPath: '/app/daemon-entry.js',
    });

    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    expect(mockSpawnDetached).toHaveBeenCalledWith('/app/daemon-entry.js', { QUEUE_CONFIG_DIR: '/home/user/.queue' });
  });

  it('passes extraEnv vars along with QUEUE_CONFIG_DIR', () => {
    const mockExistsSync = vi.fn().mockReturnValue(true);
    const mockSpawnDetached = vi.spyOn(queueCore, 'spawnDetachedProcess');

    spawnDaemon('/tmp/config', {
      existsSync: mockExistsSync,
      bundlePath: '/app/queue-daemon.cjs',
      tscPath: '/fallback/daemon-entry.js',
    }, { QUEUE_DAEMON_SCRIPT: '/path/to/daemon.js', CUSTOM_VAR: 'value' });

    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    expect(mockSpawnDetached).toHaveBeenCalledWith('/app/queue-daemon.cjs', {
      QUEUE_CONFIG_DIR: '/tmp/config',
      QUEUE_DAEMON_SCRIPT: '/path/to/daemon.js',
      CUSTOM_VAR: 'value',
    });
  });
});
