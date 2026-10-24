import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { startRelayDaemon, type RelayCommands } from './RelayDaemon.js';
import { waitFor } from './testing/waitFor.js';
import { markOnDemand, registerWaiter, unregisterWaiter, isOnDemand } from './onDemand.js';

// A separate file from RelayDaemon.test.ts on purpose: the older tests there stop daemons without replacing the forced
// process.exit that stop() arms 3 s later, so a longer file makes vitest fail on "process.exit unexpectedly called".

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-on-demand-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('on-demand relay (started by "queue wait") stops itself when nobody waits', () => {
  let configDir: string;
  let daemonHandle: Awaited<ReturnType<typeof startRelayDaemon>> | null = null;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    configDir = makeTmpDir();
    const pluginPath = join(configDir, 'plugin.js');
    writeFileSync(pluginPath, `export default { source: 'test', mapEvent: (e) => ({ event: 'test', payload: e.payload }) };`);
    // Nothing listens on port 1: the connection keeps failing and retrying, which is irrelevant to this test
    writeFileSync(join(configDir, 'relay.yml'), `relayUrl: ws://127.0.0.1:1/relay\ntoken: test-token\nplugins:\n  - module: ${pluginPath}\n    subscriptions:\n      - eventType: [test]\n`);
  });

  afterEach(async () => {
    await daemonHandle?.stop('command').catch(() => undefined);
    daemonHandle = null;
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // The shutdown hook arms a forced process.exit: replace it, the test process must not exit
  const shutdownDeps = { setTimeout: () => ({ unref: () => undefined }), exit: () => undefined, log: () => undefined };

  function relayClient() {
    return createDaemonClient<RelayCommands>({
      configDir: join(configDir, 'relay-daemon'),
      commands: { status: () => ({ connected: false, pid: 0, uptimeSec: 0, lastError: null, lastErrorAt: null, lastCloseCode: null, logError: null }) },
    });
  }

  it('stays up while a live process waits, then stops once the waiter is gone, and says why in relay.log', async () => {
    const relayDir = join(configDir, 'relay-daemon');
    markOnDemand(relayDir);
    registerWaiter(relayDir, process.pid);

    daemonHandle = await startRelayDaemon(configDir, shutdownDeps, { idleWatchdog: { graceMs: 150, intervalMs: 40 } });
    const client = relayClient();

    // Positive barrier instead of a sleep: every watchdog tick checks that the waiter's process is alive with process.kill(pid, 0),
    // so several such calls prove the watchdog ran (and left the relay up) several times while the waiter lived
    let livenessChecks = 0;
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid === process.pid && signal === 0) {
        livenessChecks++;
      }
      return realKill(pid, signal);
    });
    await waitFor(() => livenessChecks >= 5, 'the idle watchdog to check the live waiter at least 5 times');
    expect(await client.isRunning()).toBe(true);

    unregisterWaiter(relayDir, process.pid);
    await waitFor(async () => !(await client.isRunning()), 'the relay to stop itself once the waiter is gone');
    expect(await client.isRunning()).toBe(false);
    expect(readFileSync(join(relayDir, 'relay.log'), 'utf-8')).toContain('no one is waiting');
    // a stopped relay leaves no on-demand marker behind
    expect(isOnDemand(relayDir)).toBe(false);
  });

  it('a relay that was not started on demand ignores the waiters entirely', async () => {
    daemonHandle = await startRelayDaemon(configDir, shutdownDeps, { idleWatchdog: { graceMs: 100, intervalMs: 30 } });
    // Without an on-demand marker the watchdog ticks leave no observable trace, so there is no positive barrier for "it ignored the
    // waiters"; a slow machine only makes this check weaker, never failing (seam: an onTick callback in IdleWatchdogOptions).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await relayClient().isRunning()).toBe(true);
  });
});
