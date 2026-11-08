/**
 * `queue stop`: the message and the exit code agree. A daemon that is not running is an idempotent success (like `queue relay stop`);
 * a daemon that was running and is still there after the stop is the only failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { daemonStop } from './daemonStop.js';

function setup(running: boolean[], send: () => Promise<unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const isRunning = vi.fn();
  for (const value of running) {
    isRunning.mockResolvedValueOnce(value);
  }
  // after the scripted answers the daemon stays in its last known state
  isRunning.mockResolvedValue(running[running.length - 1] ?? false);
  const client = { isRunning, send: vi.fn(send) };
  const io = { stdout: { write: (s: string) => { out.push(s); } }, stderr: { write: (s: string) => { err.push(s); } } };
  return { client, io, out, err };
}

// A virtual clock: sleeping advances it, nothing really waits (the wait is the scenario's input, not a duration the test measures)
function virtualTime() {
  let t = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
}

function fast() {
  return { waitMs: 60, pollMs: 5, ...virtualTime() };
}

describe('daemonStop', () => {
  it('not running: exit 0 with an [ok] message, never [fail], and no quit is sent', async () => {
    const { client, io, out, err } = setup([false], async () => undefined);

    expect(await daemonStop(client, io, fast())).toBe(0);

    expect(err.join('')).toContain('[ok] daemon was not running');
    expect(out.join('') + err.join('')).not.toContain('[fail]');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('running, quit accepted, gone afterwards: exit 0 and [ok] daemon stopped on stdout', async () => {
    const { client, io, out } = setup([true, true, false], async () => undefined);

    expect(await daemonStop(client, io, fast())).toBe(0);

    expect(client.send).toHaveBeenCalledWith('quit', undefined);
    expect(out.join('')).toContain('[ok] daemon stopped');
  });

  it('running, quit throws because the daemon closed the connection, but it is gone: still a success', async () => {
    const { client, io, out } = setup([true, false], async () => { throw new Error('socket hang up'); });

    expect(await daemonStop(client, io, fast())).toBe(0);

    expect(out.join('')).toContain('[ok] daemon stopped');
  });

  it('running and still running after the quit: exit 1 with the error and what to do', async () => {
    const { client, io, out, err } = setup([true], async () => { throw new Error('Connection refused'); });

    expect(await daemonStop(client, io, fast())).toBe(1);

    const text = err.join('');
    expect(text).toContain('[fail] daemon did not stop');
    expect(text).toContain('Connection refused');
    expect(text).toContain('queue logs');
    expect(out.join('')).not.toContain('[ok]');
  });

  it('running, quit accepted but the daemon never goes away within the wait: exit 1', async () => {
    const { client, io, err } = setup([true], async () => undefined);

    expect(await daemonStop(client, io, fast())).toBe(1);

    expect(err.join('')).toContain('[fail] daemon did not stop');
    expect(err.join('')).toMatch(/still running after \d+ ?ms/);
  });

  it('polls every pollMs and gives up exactly when waitMs has elapsed on the injected clock', async () => {
    const { client, io, err } = setup([true], async () => undefined);
    const time = virtualTime();

    expect(await daemonStop(client, io, { waitMs: 60, pollMs: 25, sleep: time.sleep, now: time.now })).toBe(1);

    // 0, 25, 50, 75 elapsed: the check at 75 ms (>= 60) is the last one
    expect(time.sleeps).toEqual([25, 25, 25]);
    expect(err.join('')).toContain('still running after 60 ms');
  });

  it('uses the documented defaults (5000 ms wait, 100 ms poll) when nothing is injected', async () => {
    const { client, io } = setup([true], async () => undefined);
    const time = virtualTime();

    expect(await daemonStop(client, io, { sleep: time.sleep, now: time.now })).toBe(1);

    expect(time.sleeps).toHaveLength(50);
    expect(new Set(time.sleeps)).toEqual(new Set([100]));
  });

  it('stops polling as soon as the daemon is gone', async () => {
    const { client, io } = setup([true, true, true, false], async () => undefined);
    const time = virtualTime();

    expect(await daemonStop(client, io, { waitMs: 60_000, pollMs: 7, sleep: time.sleep, now: time.now })).toBe(0);

    expect(time.sleeps).toEqual([7, 7]);
  });
});
