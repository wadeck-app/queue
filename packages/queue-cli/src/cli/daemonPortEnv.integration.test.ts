import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { testBundleFile } from '../testing/testBundle.js';
import { startDaemon } from '../daemon/QueueDaemon.js';
import { waitForPortFree } from '../testWaitFor.js';

// QUEUE_DAEMON_PORT / QUEUE_RELAY_PORT against the bundled CLI and a real daemon: the daemon binds the requested port, `queue status` shows it,
// an invalid value is refused loudly (naming the variable and the value) instead of starting on another port, and a command finds its daemon
// through the config.port of ITS config dir whatever the environment says.

const bundlePath = testBundleFile('queue.cjs');

let iso: IsolatedCliEnv | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (iso !== undefined) {
    runCli(['stop']);
    await waitForPortFree(iso.daemonPort);
    iso.cleanup();
    iso = undefined;
  }
});

function env(): IsolatedCliEnv {
  iso ??= createIsolatedCliEnv();
  return iso;
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: 'utf-8',
    // Hang guard only, never a performance limit
    timeout: 300_000,
    env: { ...env().env, ...extraEnv },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 };
}

function boundPort(configDir: string): number {
  const file = join(configDir, 'config.port');
  return (JSON.parse(readFileSync(file, 'utf8')) as { port: number }).port;
}

describe('QUEUE_DAEMON_PORT', () => {
  it('the daemon binds that port, config.port and `queue status` report it, and every command finds the daemon through config.port', async () => {
    const e = env();
    const start = runCli(['start']);
    expect(start.exitCode, `queue start failed: ${start.stderr}`).toBe(0);
    expect(boundPort(e.configDir)).toBe(e.daemonPort);

    const status = runCli(['status', '--json']);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ daemonRunning: true, port: e.daemonPort });

    // The environment of this command names another port: the daemon of THIS config dir is found through its config.port, not through the variable
    const elsewhere = runCli(['status', '--json'], { QUEUE_DAEMON_PORT: '1024' });
    expect(JSON.parse(elsewhere.stdout)).toMatchObject({ daemonRunning: true, port: e.daemonPort });
  });

  it('`queue start` on a running daemon warns that a different QUEUE_DAEMON_PORT was ignored', () => {
    const e = env();
    expect(runCli(['start']).exitCode).toBe(0);
    const other = String(e.daemonPort === 50000 ? 50001 : 50000);
    const again = runCli(['start'], { QUEUE_DAEMON_PORT: other });
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toContain(`QUEUE_DAEMON_PORT=${other} was ignored`);
    expect(again.stderr).toContain(`port ${e.daemonPort}`);
  });

  it.each(['abc', '80', '70000', ''])('an invalid value %j makes `queue start` exit 1 naming the variable and the value, and no daemon starts', (value) => {
    const e = env();
    const start = runCli(['start'], { QUEUE_DAEMON_PORT: value });
    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain(`QUEUE_DAEMON_PORT=${JSON.stringify(value)} is not a valid port`);
    expect(existsSync(join(e.configDir, 'config.port'))).toBe(false);
  });

  it('any command that would start the daemon refuses an invalid value too (push)', () => {
    const push = runCli(['push', 'port.env.test', '{}'], { QUEUE_DAEMON_PORT: 'nope' });
    expect(push.exitCode).toBe(1);
    expect(push.stderr).toContain('QUEUE_DAEMON_PORT="nope"');
  });

  it('startDaemon itself refuses an invalid QUEUE_DAEMON_PORT before starting anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-daemon-port-env-'));
    try {
      vi.stubEnv('QUEUE_DAEMON_PORT', '99');
      await expect(startDaemon(dir)).rejects.toThrow('QUEUE_DAEMON_PORT="99" is not a valid port');
      expect(existsSync(join(dir, 'config.port'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('QUEUE_RELAY_PORT', () => {
  it('an invalid value makes `queue relay start` exit 1 naming the variable and the value', () => {
    const start = runCli(['relay', 'start'], { QUEUE_RELAY_PORT: '12' });
    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain('QUEUE_RELAY_PORT="12" is not a valid port');
  });
});
