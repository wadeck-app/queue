import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEnsureDaemonRunning, resolveDaemonScriptFromEnv } from './push.js';

describe('ensureDaemonRunning', () => {
  let mockIsRunning: any;
  let mockSpawn: any;
  let mockResolveEntry: any;
  let mockNow: any;
  let mockSleep: any;
  let now: number;

  beforeEach(() => {
    now = 1000;
    mockNow = vi.fn(() => now);
    mockIsRunning = vi.fn(async () => false);
    mockSpawn = vi.fn();
    mockResolveEntry = vi.fn(() => '/fake/entry.js');
    // mockSleep uses real time but we'll control 'now' for the deadline
    mockSleep = vi.fn(async (ms: number) => {
      now += ms;
    });
  });

  it('5 concurrent calls with isRunning false -> spawn called exactly once and all 5 resolve', async () => {
    mockIsRunning.mockResolvedValueOnce(false); // First check returns false

    // Simulate daemon becoming running after 200ms
    const callOrder = [false, false, false, false, false, false, false, true];
    let callCount = 0;
    mockIsRunning.mockImplementation(async () => {
      const result = callOrder[callCount];
      callCount++;
      return result;
    });

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    const configDir = '/test/config';

    // Launch 5 concurrent calls
    const results = await Promise.all([
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
    ]);

    // All should resolve successfully
    expect(results).toHaveLength(5);
    results.forEach((r) => expect(r).toBeUndefined());

    // Spawn should be called exactly once
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('/fake/entry.js', {
      QUEUE_CONFIG_DIR: configDir,
    });
  });

  it('already running -> spawn never called', async () => {
    mockIsRunning.mockResolvedValueOnce(true);

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    const configDir = '/test/config';
    await ensureDaemonRunning(configDir);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('timeout -> all concurrent callers reject with same error, in-flight entry cleared so following call spawns again', async () => {
    // First call sequence: all return false (simulating timeout)
    mockIsRunning.mockResolvedValue(false);

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    const configDir = '/test/config';

    // Launch 5 concurrent calls - they should all timeout
    const promises = [
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
      ensureDaemonRunning(configDir),
    ];

    const errors = await Promise.allSettled(promises);

    // All should reject with the same error message
    errors.forEach((result) => {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason.message).toContain(
        'Failed to start the queue daemon within 5s'
      );
      expect((result as PromiseRejectedResult).reason.message).toContain('Check /test/config/logs');
    });

    // spawn should be called once for the failed start
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Reset mocks
    mockSpawn.mockClear();
    mockIsRunning.mockClear();
    now = 1000;

    // Simulate daemon now becomes running
    mockIsRunning.mockResolvedValueOnce(false);
    mockIsRunning.mockResolvedValueOnce(true);

    // A following call should spawn again
    await ensureDaemonRunning(configDir);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('two different configDirs -> two spawns', async () => {
    let callSequence = [false, true];
    let callCount = 0;
    mockIsRunning.mockImplementation(async () => {
      const result = callSequence[callCount];
      callCount++;
      return result;
    });

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    await ensureDaemonRunning('/test/config1');

    // Reset for second config dir
    callCount = 0;
    callSequence = [false, true];

    await ensureDaemonRunning('/test/config2');

    // spawn should be called twice (once per configDir)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(1, '/fake/entry.js', {
      QUEUE_CONFIG_DIR: '/test/config1',
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, '/fake/entry.js', {
      QUEUE_CONFIG_DIR: '/test/config2',
    });
  });

  it('rejecting isRunning in poll loop treated as not yet running, not thrown', async () => {
    const callSequence = [false, new Error('connection failed'), new Error('connection failed'), true];
    let callCount = 0;
    mockIsRunning.mockImplementation(async () => {
      const result = callSequence[callCount];
      callCount++;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    });

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    const configDir = '/test/config';

    // Should not throw, should eventually resolve when daemon is running
    await ensureDaemonRunning(configDir);

    // spawn should be called once
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('resolve entry is called lazily inside the start path', async () => {
    // First call: already running, entry should not be resolved
    mockIsRunning.mockResolvedValueOnce(true);

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: mockIsRunning,
      spawn: mockSpawn,
      resolveEntry: mockResolveEntry,
      now: mockNow,
      sleep: mockSleep,
      timeoutMs: 5000,
    });

    const configDir = '/test/config';
    await ensureDaemonRunning(configDir);

    // resolveEntry should not have been called
    expect(mockResolveEntry).not.toHaveBeenCalled();

    // Now test when not running
    mockIsRunning.mockResolvedValueOnce(false);
    mockIsRunning.mockResolvedValueOnce(true);

    await ensureDaemonRunning('/test/config2');

    // resolveEntry should have been called exactly once
    expect(mockResolveEntry).toHaveBeenCalledTimes(1);
  });

  it('resolveEntry throws synchronously -> first call rejects; second call (resolveEntry fixed) spawns and resolves', async () => {
    const configDir = '/test/config';
    let resolveCallCount = 0;

    // Create mocks that will be different for first and second call
    const testResolveEntry = vi.fn(() => {
      resolveCallCount++;
      if (resolveCallCount === 1) {
        throw new Error('MODULE_NOT_FOUND: queue-core not installed');
      }
      return '/fake/entry.js';
    });

    const testIsRunning = vi.fn(async (cd: string) => {
      // Initially not running for config dir
      if (cd !== configDir) {
        return false;
      }
      // First call sequence: not running, then running after spawn fails
      // Second call: not running, then running after successful spawn
      return false;
    });
    let pollCount = 0;
    testIsRunning.mockImplementation(async () => {
      pollCount++;
      return pollCount > 1; // Return true after first check
    });

    const testSpawn = vi.fn();
    const testNow = vi.fn(() => now);
    const testSleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: testIsRunning,
      spawn: testSpawn,
      resolveEntry: testResolveEntry,
      now: testNow,
      sleep: testSleep,
      timeoutMs: 5000,
    });

    // First call should reject
    const firstError = await ensureDaemonRunning(configDir).catch((e) => e);
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError.message).toContain('MODULE_NOT_FOUND');

    // Reset for second call
    pollCount = 0;
    now = 1000;
    testSpawn.mockClear();
    testIsRunning.mockClear();
    testIsRunning.mockImplementation(async () => {
      pollCount++;
      return pollCount > 1; // Return true after first check
    });

    // Install unhandledRejection spy for second call
    const unhandledErrors: any[] = [];
    const rejectHandler = vi.fn((reason) => {
      unhandledErrors.push(reason);
    });
    process.on('unhandledRejection', rejectHandler);

    // Second call with resolveEntry fixed should spawn and resolve
    await ensureDaemonRunning(configDir);

    // Clean up spy
    process.removeListener('unhandledRejection', rejectHandler);

    // spawn should have been called exactly once (from second call)
    expect(testSpawn).toHaveBeenCalledTimes(1);
    expect(testSpawn).toHaveBeenCalledWith('/fake/entry.js', {
      QUEUE_CONFIG_DIR: configDir,
    });

    // No unhandled rejections should have occurred
    expect(unhandledErrors).toHaveLength(0);
  });

  it('spawn throws synchronously -> first call rejects; second call (spawn fixed) spawns and resolves', async () => {
    const configDir = '/test/config';
    let spawnCallCount = 0;

    // Create mocks that will be different for first and second call
    const testResolveEntry = vi.fn(() => '/fake/entry.js');

    const testSpawn = vi.fn(() => {
      spawnCallCount++;
      if (spawnCallCount === 1) {
        throw new Error('Failed to spawn process');
      }
    });

    let pollCount = 0;
    const testIsRunning = vi.fn(async () => {
      pollCount++;
      return pollCount > 1; // Return true after first check
    });

    const testNow = vi.fn(() => now);
    const testSleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    const ensureDaemonRunning = createEnsureDaemonRunning({
      isRunning: testIsRunning,
      spawn: testSpawn,
      resolveEntry: testResolveEntry,
      now: testNow,
      sleep: testSleep,
      timeoutMs: 5000,
    });

    // First call should reject
    const firstError = await ensureDaemonRunning(configDir).catch((e) => e);
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError.message).toContain('Failed to spawn process');

    // Reset for second call
    pollCount = 0;
    now = 1000;
    testIsRunning.mockClear();
    testIsRunning.mockImplementation(async () => {
      pollCount++;
      return pollCount > 1; // Return true after first check
    });

    // Install unhandledRejection spy for second call
    const unhandledErrors: any[] = [];
    const rejectHandler = vi.fn((reason) => {
      unhandledErrors.push(reason);
    });
    process.on('unhandledRejection', rejectHandler);

    // Second call with spawn fixed should spawn and resolve
    await ensureDaemonRunning(configDir);

    // Clean up spy
    process.removeListener('unhandledRejection', rejectHandler);

    // spawn should have been called exactly twice (first was failing, second succeeded)
    expect(testSpawn).toHaveBeenCalledTimes(2);

    // No unhandled rejections should have occurred
    expect(unhandledErrors).toHaveLength(0);
  });
});

describe('resolveDaemonScriptFromEnv', () => {
  let originalEnv: string | undefined;
  let tempFile: string;

  beforeEach(() => {
    // Save original env value
    originalEnv = process.env.QUEUE_DAEMON_SCRIPT;
    // Create a temp file for testing
    tempFile = path.join(os.tmpdir(), `test-daemon-${Date.now()}.js`);
    fs.writeFileSync(tempFile, '// test daemon');
  });

  afterEach(() => {
    // Restore original env value
    if (originalEnv === undefined) {
      delete process.env.QUEUE_DAEMON_SCRIPT;
    } else {
      process.env.QUEUE_DAEMON_SCRIPT = originalEnv;
    }
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  });

  it('env set and file exists -> returns the path', () => {
    process.env.QUEUE_DAEMON_SCRIPT = tempFile;
    const result = resolveDaemonScriptFromEnv();
    expect(result).toBe(tempFile);
  });

  it('env set but file does not exist -> throws exact error message', () => {
    const nonexistentPath = path.join(os.tmpdir(), 'nonexistent-daemon.js');
    process.env.QUEUE_DAEMON_SCRIPT = nonexistentPath;

    expect(() => {
      resolveDaemonScriptFromEnv();
    }).toThrow(
      `QUEUE_DAEMON_SCRIPT points to a file that does not exist: ${nonexistentPath}. Restart the relay with 'queue relay stop' then 'queue relay start'.`
    );
  });

  it('env not set -> throws exact error message', () => {
    delete process.env.QUEUE_DAEMON_SCRIPT;

    expect(() => {
      resolveDaemonScriptFromEnv();
    }).toThrow(
      `Cannot locate the queue daemon script to wake the daemon: QUEUE_DAEMON_SCRIPT is not set. Start the relay with 'queue relay start' (it passes the script path), or start the queue daemon yourself with 'queue start'.`
    );
  });
});
