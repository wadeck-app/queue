import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { relayStart, type RelayStartDeps } from './relayStart.js';

type Config = { relayUrl: string; token: string; tokenSource?: 'env' | 'secrets' | 'relay.yml'; plugins: Array<{ module: string; subscriptions: unknown[] }> };

interface MockDeps {
  client: { isRunning: Mock<() => Promise<boolean>> };
  loadConfig: Mock<(configDir: string) => Config | null>;
  resolveDaemonScript: Mock<() => string>;
  getQueueDaemonScript: Mock<() => string>;
  spawn: Mock<(script: string, configDir: string, env: Record<string, string>) => void>;
  waitForDaemon: Mock<(ms: number) => Promise<boolean>>;
  readLogTail: Mock<(path: string, lines: number) => string[] | null>;
  io: {
    stdout: { write: Mock<(s: string) => void> };
    stderr: { write: Mock<(s: string) => void> };
  };
}

// The mocks cover exactly what relayStart uses of the daemon client; the real DaemonClient has more members
function asDeps(deps: MockDeps): RelayStartDeps {
  return deps as unknown as RelayStartDeps;
}

function createMockDeps(): MockDeps {
  return {
    client: {
      isRunning: vi.fn().mockResolvedValue(false),
    },
    loadConfig: vi.fn().mockReturnValue(null),
    resolveDaemonScript: vi.fn().mockReturnValue('/path/to/relay-daemon.js'),
    getQueueDaemonScript: vi.fn().mockReturnValue('/path/to/queue-daemon.js'),
    spawn: vi.fn(),
    waitForDaemon: vi.fn().mockResolvedValue(false),
    readLogTail: vi.fn().mockReturnValue([]),
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    },
  };
}

describe('relayStart', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  describe('already running case', () => {
    it('returns 0 and writes [ok] to stderr when relay is already running', async () => {
      deps.client.isRunning.mockResolvedValue(true);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(0);
      expect(deps.io.stderr.write.mock.calls[0][0]).toContain('[ok] relay client already running');
      // spawn should NOT be called
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('missing relay.yml case', () => {
    it('returns 1 when relay.yml does not exist', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue(null);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      expect(stderrCalls.join('')).toContain('No relay.yml in');
      expect(stderrCalls.join('')).toContain('Create it as');
      // spawn should NOT be called
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('invalid relay.yml case', () => {
    it('returns 1 and writes error message when relay.yml is invalid', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockImplementation(() => {
        throw new Error('Invalid config: missing relayUrl');
      });

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      expect(stderrCalls.join('')).toContain('[fail]');
      expect(stderrCalls.join('')).toContain('Invalid config: missing relayUrl');
      // spawn should NOT be called
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('zero plugins case', () => {
    it('returns 1 when relay.yml has no plugins configured', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'env',
        plugins: [],
      });

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      expect(stderrCalls.join('')).toContain('[fail]');
      expect(stderrCalls.join('')).toContain('no plugins configured');
      // spawn should NOT be called
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('daemon script resolution failure case', () => {
    it('returns 1 when daemon script cannot be resolved', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'env',
        plugins: [{ module: 'plugin', subscriptions: [{ eventType: ['test'] }] }],
      });
      deps.resolveDaemonScript.mockImplementation(() => {
        throw new Error('Cannot find module');
      });

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      expect(stderrCalls.join('')).toContain('[fail]');
      expect(stderrCalls.join('')).toContain('relay daemon script was not found');
      expect(stderrCalls.join('')).toContain('Reinstall or update');
      // spawn should NOT be called
      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('successful start case', () => {
    it('returns 0 when daemon starts successfully and passes both env vars', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'env',
        plugins: [{ module: 'plugin', subscriptions: [{ eventType: ['test'] }] }],
      });
      deps.resolveDaemonScript.mockReturnValue('/path/to/relay-daemon.js');
      deps.getQueueDaemonScript.mockReturnValue('/path/to/queue-daemon.js');
      deps.waitForDaemon.mockResolvedValue(true);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(0);
      const stdoutCalls = deps.io.stdout.write.mock.calls.map(c => c[0]);
      expect(stdoutCalls.join('')).toContain('[ok] relay client started');
      expect(deps.spawn).toHaveBeenCalledWith('/path/to/relay-daemon.js', '/config', {
        QUEUE_DAEMON_SCRIPT: '/path/to/queue-daemon.js',
      });
    });

    it('prints warning when token is from relay.yml (deprecated)', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'relay.yml',
        plugins: [{ module: 'plugin', subscriptions: [{ eventType: ['test'] }] }],
      });
      deps.resolveDaemonScript.mockReturnValue('/path/to/relay-daemon.js');
      deps.getQueueDaemonScript.mockReturnValue('/path/to/queue-daemon.js');
      deps.waitForDaemon.mockResolvedValue(true);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(0);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      expect(stderrCalls.join('')).toContain('[warn]');
      expect(stderrCalls.join('')).toContain('relay token is read from relay.yml');
      expect(stderrCalls.join('')).toContain('_secrets_/.env.local');
    });
  });

  describe('timeout case', () => {
    it('returns 1 and shows log tail when daemon times out', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'env',
        plugins: [{ module: 'plugin', subscriptions: [{ eventType: ['test'] }] }],
      });
      deps.resolveDaemonScript.mockReturnValue('/path/to/relay-daemon.js');
      deps.getQueueDaemonScript.mockReturnValue('/path/to/queue-daemon.js');
      deps.waitForDaemon.mockResolvedValue(false);
      deps.readLogTail.mockReturnValue([
        'line 1',
        'line 2',
        'line 3',
      ]);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      const combined = stderrCalls.join('');
      expect(combined).toContain('[fail] relay client failed to start within 5s');
      expect(combined).toContain('line 1');
      expect(combined).toContain('line 2');
      expect(combined).toContain('Full log:');
    });

    it('returns 1 and shows helpful error when log does not exist', async () => {
      deps.client.isRunning.mockResolvedValue(false);
      deps.loadConfig.mockReturnValue({
        relayUrl: 'https://example.com',
        token: 'token123',
        tokenSource: 'env',
        plugins: [{ module: 'plugin', subscriptions: [{ eventType: ['test'] }] }],
      });
      deps.resolveDaemonScript.mockReturnValue('/path/to/relay-daemon.js');
      deps.getQueueDaemonScript.mockReturnValue('/path/to/queue-daemon.js');
      deps.waitForDaemon.mockResolvedValue(false);
      deps.readLogTail.mockReturnValue(null);

      const exitCode = await relayStart(asDeps(deps), '/config');

      expect(exitCode).toBe(1);
      const stderrCalls = deps.io.stderr.write.mock.calls.map(c => c[0]);
      const combined = stderrCalls.join('');
      expect(combined).toContain('[fail] relay client failed to start within 5s');
      expect(combined).toContain('No log was written');
      expect(combined).toContain('Run it in the foreground');
      expect(combined).toContain('QUEUE_CONFIG_DIR=');
    });
  });
});
