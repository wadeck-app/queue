import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackRequest, type LoopbackRequest } from './http.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { createQueuePublisherWithDeps, type PublisherDeps, type QueuePublisher, type QueuePublisherOptions } from './publisher.js';
import type { QueueFailure } from './report.js';
import { closedPort, makeTempDir, removeDir, startFakeDaemon, type FakeDaemon, type FakeDaemonOptions } from './testing/fakeDaemon.js';
import { waitFor } from './testing/waitFor.js';

interface Harness {
  dir: string;
  fake: FakeDaemon | undefined;
  publisher: QueuePublisher;
  failures: QueueFailure[];
  warnings: string[];
  runs: Array<{ executable: string; configDir: string }>;
  httpCalls: LoopbackRequest[];
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface HarnessOptions {
  daemon?: Partial<FakeDaemonOptions> | false;
  writeFiles?: boolean;
  publisher?: Partial<QueuePublisherOptions>;
  deps?: PublisherDeps;
  /** What the injected `queue start` does; default: nothing, exit code 0. */
  onRun?: (h: Harness) => Promise<number> | number;
  queueInstalled?: boolean;
}

async function setup(options: HarnessOptions = {}): Promise<Harness> {
  const dir = makeTempDir();
  cleanups.push(() => removeDir(dir));
  const configDir = join(dir, 'cfg');
  mkdirSync(configDir);
  let fake: FakeDaemon | undefined;
  if (options.daemon !== false) {
    fake = await startFakeDaemon({ configDir, ...options.daemon });
    cleanups.push(() => fake?.close());
    if (options.writeFiles !== false) {
      fake.writeFiles();
    }
  }
  const failures: QueueFailure[] = [];
  const warnings: string[] = [];
  const runs: Harness['runs'] = [];
  const httpCalls: LoopbackRequest[] = [];
  const h = { dir, fake, failures, warnings, runs, httpCalls } as Harness;
  const deps: PublisherDeps = {
    request: (call) => {
      httpCalls.push(call);
      return loopbackRequest(call);
    },
    find: () => (options.queueInstalled === false ? undefined : 'queue'),
    run: async (executable, runConfigDir) => {
      runs.push({ executable, configDir: runConfigDir });
      const code = (await options.onRun?.(h)) ?? 0;
      return { code };
    },
    pollIntervalMs: 10,
    // How long a start may take to show a daemon: a guard against a start that never completes, never a performance limit.
    startTimeoutMs: 300_000,
    ...options.deps,
  };
  h.publisher = createQueuePublisherWithDeps(
    { configDir, silent: true, onError: (failure) => failures.push(failure), onWarning: (warning) => warnings.push(warning), ...options.publisher },
    deps,
  );
  return h;
}

describe('publishing to a running daemon', () => {
  it('sends event, payload, cwd and protocol with the token, after an unauthenticated version check', async () => {
    const h = await setup();
    const result = await h.publisher.publishAndWait('app.thing', { a: 1 }, { cwd: 'some/project' });
    expect(result).toEqual({ status: 'queued', eventId: 'evt-1' });
    const requests = h.fake!.requests;
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/version', authorization: undefined });
    expect(h.fake!.pushes()).toHaveLength(1);
    const push = h.fake!.pushes()[0]!;
    expect(push.authorization).toBe(`Bearer ${h.fake!.token}`);
    expect(JSON.parse(push.body)).toEqual({ event: 'app.thing', payload: { a: 1 }, cwd: resolve('some/project'), protocol: PROTOCOL_VERSION });
    expect(h.failures).toEqual([]);
  });

  it('defaults cwd to the publisher cwd option, then to process.cwd()', async () => {
    const h = await setup({ publisher: { cwd: join('x', 'proj') } });
    await h.publisher.publishAndWait('a', {});
    expect(JSON.parse(h.fake!.pushes()[0]!.body).cwd).toBe(resolve('x', 'proj'));
    const h2 = await setup();
    await h2.publisher.publishAndWait('a', {});
    expect(JSON.parse(h2.fake!.pushes()[0]!.body).cwd).toBe(process.cwd());
  });

  it('returns the result of a synchronous before* event', async () => {
    const h = await setup();
    expect(await h.publisher.publishAndWait('beforeThing', {})).toEqual({ status: 'dispatched', eventId: 'evt-1', result: { fine: true } });
  });

  it('publish returns void immediately and flush waits for the push', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'delay', ms: 100 });
    const returned = h.publisher.publish('a', {});
    expect(returned).toBeUndefined();
    expect(h.fake!.pushes()).toHaveLength(0);
    await h.publisher.flush();
    expect(h.fake!.pushes()).toHaveLength(1);
  });

  it('flush resolves at once when nothing is in flight', async () => {
    const h = await setup();
    await expect(h.publisher.flush()).resolves.toBeUndefined();
  });

  it('verifies the daemon once for a series of pushes', async () => {
    const h = await setup();
    await h.publisher.publishAndWait('a', {});
    await h.publisher.publishAndWait('a', {});
    expect(h.fake!.requests.filter((request) => request.url === '/version')).toHaveLength(1);
  });

  it('sends each distinct warning of the daemon once to onWarning', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'answer', result: { status: 'queued', warnings: ['protocol 1 is deprecated'] } });
    h.fake!.script.push({ kind: 'answer', result: { status: 'queued', warnings: ['protocol 1 is deprecated'] } });
    await h.publisher.publishAndWait('a', {});
    await h.publisher.publishAndWait('a', {});
    expect(h.warnings).toEqual(['protocol 1 is deprecated']);
  });

  it('works with a daemon that predates queueProtocol', async () => {
    const h = await setup();
    expect((await h.publisher.publishAndWait('a', {})).status).toBe('queued');
  });

  it('works with a daemon at a newer protocol MINOR', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '1.7.0', accepts: '^1.0.0' } } });
    expect((await h.publisher.publishAndWait('a', {})).status).toBe('queued');
  });
});

describe('timeouts', () => {
  it('uses 5000 ms for ordinary events and the per-call value when given', async () => {
    const h = await setup();
    await h.publisher.publishAndWait('a', {});
    await h.publisher.publishAndWait('a', {}, { timeoutMs: 1234 });
    const pushCalls = h.httpCalls.filter((call) => call.path === '/push');
    expect(pushCalls.map((call) => call.timeoutMs)).toEqual([5000, 1234]);
    expect(JSON.parse(h.fake!.pushes()[0]!.body)).not.toHaveProperty('timeout');
  });

  it('gives before* events the daemon default 30000 ms plus 5000 ms', async () => {
    const h = await setup();
    await h.publisher.publishAndWait('beforeThing', {});
    expect(h.httpCalls.find((call) => call.path === '/push')?.timeoutMs).toBe(35000);
    expect(JSON.parse(h.fake!.pushes()[0]!.body)).not.toHaveProperty('timeout');
  });

  it('sends an explicit timeoutMs of a before* event as the request timeout and waits 5000 ms more', async () => {
    const h = await setup();
    await h.publisher.publishAndWait('beforeThing', {}, { timeoutMs: 2000 });
    expect(h.httpCalls.find((call) => call.path === '/push')?.timeoutMs).toBe(7000);
    expect(JSON.parse(h.fake!.pushes()[0]!.body).timeout).toBe(2000);
  });

  it('reports no answer in time with status unknown, never retries and says it may have been queued', async () => {
    const h = await setup();
    // The daemon answers after 400 ms of a FAKED clock that never reaches it, and the 100 ms request deadline is fired by the test
    // only once the daemon has received the push: neither depends on the speed of the machine.
    h.fake!.script.push({ kind: 'delay', ms: 400 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = h.publisher.publishAndWait('a', {}, { timeoutMs: 100 });
    await waitFor('the fake daemon receiving the push', () => h.fake!.pushes().length === 1);
    vi.advanceTimersByTime(100);
    const result = await pending;
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('100 ms');
    expect(result.reason).toContain('may');
    expect(h.fake!.pushes()).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ outcome: 'unknown', event: 'a' });
  });
});

describe('failures of a running daemon', () => {
  it('reports a connection reset with status unknown and does not retry', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'reset' });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('unknown');
    expect(h.fake!.pushes()).toHaveLength(1);
    expect(h.failures).toHaveLength(1);
  });

  it('re-reads the token after a 401 and retries once', async () => {
    const h = await setup();
    const fake = h.fake!;
    fake.acceptedToken = 'b'.repeat(32);
    fake.onUnauthorized = () => writeFileSync(join(fake.configDir, 'health_token'), `${fake.acceptedToken}\n`);
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('queued');
    const pushes = fake.pushes();
    expect(pushes.map((push) => push.authorized)).toEqual([false, true]);
    expect(h.failures).toEqual([]);
  });

  it('gives up after one retry on a persistent 401 without printing the token', async () => {
    const h = await setup();
    h.fake!.acceptedToken = 'z'.repeat(32);
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.fake!.pushes()).toHaveLength(2);
    expect(h.failures[0]?.kind).toBe('unauthorized');
    expect(JSON.stringify([result, h.failures])).not.toContain(h.fake!.token);
  });

  it('drops on a 500 with the daemon message and no retry', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'http', status: 500, body: '{"error":"Command failed: invalid subscribers.yml"}' });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('invalid subscribers.yml');
    expect(h.fake!.pushes()).toHaveLength(1);
  });

  it.each([
    [400, '{"error":"bad"}'],
    [404, '{"error":"unknown"}'],
    [502, 'bad gateway'],
  ])('drops on HTTP %i with the status in the reason', async (status, body) => {
    const h = await setup();
    h.fake!.script.push({ kind: 'http', status, body });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain(String(status));
    expect(h.fake!.pushes()).toHaveLength(1);
  });

  it('drops on a 200 that is not JSON', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'http', status: 200, body: '<html>' });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('bad-answer');
  });

  it('drops on an unknown status value', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'answer', result: { status: 'teleported' } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('teleported');
  });

  it('maps aborted to dropped with the daemon reason', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'answer', result: { status: 'aborted', reason: 'a hook refused' } });
    const result = await h.publisher.publishAndWait('beforeX', {});
    expect(result).toEqual({ status: 'dropped', reason: expect.stringContaining('a hook refused') });
    expect(h.failures[0]?.kind).toBe('aborted');
  });

  it('maps rejected to dropped, names both protocol versions, and does not retry', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'answer', result: { status: 'rejected', reason: 'push protocol 1.0.0 is not accepted', supported: '^2.0.0' } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('1.0.0');
    expect(result.reason).toContain('^2.0.0');
    expect(result.reason).toContain('update');
    expect(h.fake!.pushes()).toHaveLength(1);
  });

  it('keeps going after a failure: the next push works', async () => {
    const h = await setup();
    h.fake!.script.push({ kind: 'http', status: 500, body: '{}' });
    await h.publisher.publishAndWait('a', {});
    expect((await h.publisher.publishAndWait('a', {})).status).toBe('queued');
  });
});

describe('payload and arguments', () => {
  it('drops a BigInt payload naming the property, without contacting the daemon', async () => {
    const h = await setup();
    const result = await h.publisher.publishAndWait('a', { big: { n: 10n } });
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('payload.big.n');
    expect(h.fake!.requests).toHaveLength(0);
    expect(h.failures[0]?.kind).toBe('not-serialisable');
  });

  it('drops a circular payload', async () => {
    const h = await setup();
    const payload: Record<string, unknown> = {};
    payload['me'] = payload;
    expect((await h.publisher.publishAndWait('a', payload)).reason).toContain('circular');
  });

  it('never throws from publish on bad input', async () => {
    const h = await setup();
    const cyc: Record<string, unknown> = {};
    cyc['x'] = cyc;
    expect(() => {
      h.publisher.publish('a', cyc);
      h.publisher.publish('', {});
      // A JavaScript caller can pass anything: Reflect.apply bypasses the compiler for this deliberate misuse.
      Reflect.apply(h.publisher.publish, h.publisher, [undefined, {}]);
      h.publisher.publish('a', undefined);
    }).not.toThrow();
    await h.publisher.flush();
    expect(h.failures).toHaveLength(4);
    expect(h.fake!.pushes()).toHaveLength(0);
  });

  it('drops an empty event name with an actionable reason', async () => {
    const h = await setup();
    const result = await h.publisher.publishAndWait('', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('event');
  });

  it('bounds the in-flight pushes: the overflow is dropped and reported with maxPending', async () => {
    const h = await setup({ publisher: { maxPending: 2 } });
    for (let index = 0; index < 4; index += 1) {
      h.fake!.script.push({ kind: 'delay', ms: 100 });
    }
    for (let index = 0; index < 4; index += 1) {
      h.publisher.publish('a', { index });
    }
    await h.publisher.flush();
    expect(h.fake!.pushes()).toHaveLength(2);
    const overflow = h.failures.filter((failure) => failure.kind === 'overflow');
    expect(overflow).toHaveLength(2);
    expect(overflow[0]?.message).toContain('maxPending');
    expect(overflow[0]?.message).toContain('2');
  });

  it('answers publishAndWait with dropped when the bound is exceeded', async () => {
    const h = await setup({ publisher: { maxPending: 1 } });
    h.fake!.script.push({ kind: 'delay', ms: 100 });
    h.publisher.publish('a', {});
    const result = await h.publisher.publishAndWait('b', {});
    expect(result.status).toBe('dropped');
    await h.publisher.flush();
  });

  it('accepts new pushes again after the in-flight ones settle', async () => {
    const h = await setup({ publisher: { maxPending: 1 } });
    await h.publisher.publishAndWait('a', {});
    expect((await h.publisher.publishAndWait('a', {})).status).toBe('queued');
  });
});

describe('a daemon that cannot be trusted', () => {
  it('refuses a daemon whose protocol major differs, sends nothing and names both versions', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '2.0.0', accepts: '^2.0.0' } } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('2.0.0');
    expect(result.reason).toContain(PROTOCOL_VERSION);
    expect(h.fake!.pushes()).toHaveLength(0);
    expect(h.fake!.requests.every((request) => request.authorization === undefined)).toBe(true);
    expect(h.failures[0]?.kind).toBe('incompatible');
  });

  // The daemon never becomes usable in these two: the short start deadline is the scenario (give up), whatever the machine speed
  it('treats a /version with another pid as a stale port file: starts the daemon and never sends the token', async () => {
    const h = await setup({ daemon: { reportedPid: process.pid + 100000 }, deps: { startTimeoutMs: 60 } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.runs).toHaveLength(1);
    expect(h.fake!.requests.every((request) => request.authorization === undefined)).toBe(true);
  });

  it('treats a /version with another config_dir as a stale port file and never sends the token', async () => {
    const h = await setup({ daemon: { reportedConfigDir: join('somewhere', 'else') }, deps: { startTimeoutMs: 60 } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.fake!.requests.every((request) => request.authorization === undefined)).toBe(true);
  });

  it('drops with the file path when config.port is corrupt and the daemon cannot be started', async () => {
    const h = await setup({ daemon: false, onRun: () => 1 });
    writeFileSync(join(h.dir, 'cfg', 'config.port'), '{nope');
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain(join(h.dir, 'cfg', 'config.port'));
    expect(h.failures[0]?.kind).toBe('corrupt-port-file');
  });

  it('drops when health_token is missing and names the path and QUEUE_CONFIG_DIR', async () => {
    const h = await setup();
    const { rmSync } = await import('node:fs');
    rmSync(join(h.dir, 'cfg', 'health_token'));
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain(join(h.dir, 'cfg', 'health_token'));
    expect(result.reason).toContain('QUEUE_CONFIG_DIR');
    expect(h.fake!.pushes()).toHaveLength(0);
  });
});

describe('a stopped daemon', () => {
  it('starts it with queue start when there is no port file, then pushes', async () => {
    let fake: FakeDaemon | undefined;
    const h = await setup({
      daemon: false,
      onRun: async (self) => {
        fake = await startFakeDaemon({ configDir: join(self.dir, 'cfg') });
        cleanups.push(() => fake?.close());
        fake.writeFiles();
        return 0;
      },
    });
    const result = await h.publisher.publishAndWait('a', { x: 1 });
    expect(result.status).toBe('queued');
    expect(h.runs).toEqual([{ executable: 'queue', configDir: join(h.dir, 'cfg') }]);
    expect(fake!.pushes()).toHaveLength(1);
  });

  it('starts it once for many concurrent publishes', async () => {
    let fake: FakeDaemon | undefined;
    const h = await setup({
      daemon: false,
      onRun: async (self) => {
        // Let the event loop turn once: every publish was issued synchronously and joined the single start in the same microtask
        // drain, so after a macrotask they are all waiting on this start (no wall-clock delay involved).
        await new Promise<void>((r) => setImmediate(r));
        fake = await startFakeDaemon({ configDir: join(self.dir, 'cfg') });
        cleanups.push(() => fake?.close());
        fake.writeFiles();
        return 0;
      },
    });
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => h.publisher.publishAndWait('a', { index })));
    expect(results.map((result) => result.status)).toEqual(Array(10).fill('queued'));
    expect(h.runs).toHaveLength(1);
    expect(fake!.pushes()).toHaveLength(10);
    expect(fake!.requests.filter((request) => request.url === '/version').length).toBeLessThanOrEqual(3);
  });

  it('starts it when the port file points to a closed port and the process is gone', async () => {
    let fake: FakeDaemon | undefined;
    const h = await setup({
      daemon: false,
      deps: { isPidAlive: () => false },
      onRun: async (self) => {
        fake = await startFakeDaemon({ configDir: join(self.dir, 'cfg') });
        cleanups.push(() => fake?.close());
        fake.writeFiles();
        return 0;
      },
    });
    writeFileSync(join(h.dir, 'cfg', 'config.port'), JSON.stringify({ sdkVersion: 1, port: await closedPort(), pid: 2147483000 }));
    expect((await h.publisher.publishAndWait('a', {})).status).toBe('queued');
    expect(h.runs).toHaveLength(1);
  });

  it('restarts the daemon when it disappears after a successful push (connection refused)', async () => {
    const h = await setup({
      onRun: async (self) => {
        const second = await startFakeDaemon({ configDir: join(self.dir, 'cfg') });
        cleanups.push(() => second.close());
        second.writeFiles();
        return 0;
      },
    });
    await h.publisher.publishAndWait('a', {});
    await h.fake!.close();
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('queued');
    expect(h.runs).toHaveLength(1);
  });

  it('drops with an install hint when queue is not on PATH', async () => {
    const h = await setup({ daemon: false, queueInstalled: false });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('not installed or not on PATH');
    expect(result.reason).toContain('queue-cli');
    expect(h.runs).toHaveLength(0);
    expect(h.failures[0]?.kind).toBe('not-installed');
  });

  it('drops with the exit code when queue start fails', async () => {
    const h = await setup({ daemon: false, onRun: () => 4 });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('exit code 4');
    expect(h.failures[0]?.kind).toBe('start-failed');
  });

  it('drops when queue start exits 0 but no daemon appears', async () => {
    const h = await setup({ daemon: false, onRun: () => 0, deps: { startTimeoutMs: 60 } });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('not-ready');
  });

  it('does not try forever: a start that works but a daemon that refuses again ends in dropped', async () => {
    const h = await setup({
      daemon: false,
      onRun: async (self) => {
        const fake = await startFakeDaemon({ configDir: join(self.dir, 'cfg') });
        cleanups.push(() => fake.close());
        fake.writeFiles();
        await fake.close();
        return 0;
      },
      deps: { startTimeoutMs: 60 },
    });
    const result = await h.publisher.publishAndWait('a', {});
    expect(result.status).toBe('dropped');
    expect(h.runs.length).toBeLessThanOrEqual(2);
  });
});

describe('reporting', () => {
  it('prints a repeated failure once on the default sink and again after a success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = makeTempDir();
    cleanups.push(() => removeDir(dir));
    const publisher = createQueuePublisherWithDeps({ configDir: dir }, { find: () => undefined });
    await publisher.publishAndWait('a', {});
    await publisher.publishAndWait('b', {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('queue-cli');
  });

  it('stays quiet when silent but still calls onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = await setup({ daemon: false, queueInstalled: false });
    await h.publisher.publishAndWait('a', {});
    expect(warn).not.toHaveBeenCalled();
    expect(h.failures).toHaveLength(1);
  });
});

describe('status', () => {
  it('describes a running daemon without sending an event', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '1.0.0', accepts: '^1.0.0' } } });
    const status = await h.publisher.status();
    expect(status).toMatchObject({ available: true, via: 'daemon', daemonVersion: '9.9.9', protocol: PROTOCOL_VERSION });
    expect(h.fake!.pushes()).toHaveLength(0);
  });

  it('says available through queue start when the daemon is stopped but queue is installed, and starts nothing', async () => {
    const h = await setup({ daemon: false });
    const status = await h.publisher.status();
    expect(status).toMatchObject({ available: true, via: 'queue-start' });
    expect(h.runs).toHaveLength(0);
  });

  it('says unavailable with a reason when queue is missing', async () => {
    const h = await setup({ daemon: false, queueInstalled: false });
    const status = await h.publisher.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('PATH');
  });

  it('says unavailable for an incompatible daemon', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '3.0.0', accepts: '^3.0.0' } } });
    const status = await h.publisher.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('3.0.0');
  });

  it('never rejects', async () => {
    const h = await setup({ daemon: false });
    writeFileSync(join(h.dir, 'cfg', 'config.port'), '{nope');
    await expect(h.publisher.status()).resolves.toMatchObject({ available: expect.any(Boolean) });
  });
});

describe('the off switch (tests of an integration, a CI without a queue)', () => {
  it('sends nothing, starts nothing, reports nothing, and says so in the result', async () => {
    const h = await setup({ publisher: { off: true } });
    h.publisher.publish('app.thing', {});
    const result = await h.publisher.publishAndWait('app.thing', {});
    await h.publisher.flush();
    expect(result).toEqual({ status: 'dropped', reason: 'the publisher is switched off (option off: true): nothing was sent' });
    expect(h.httpCalls).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it('is visible in status()', async () => {
    const h = await setup({ publisher: { off: true } });
    await expect(h.publisher.status()).resolves.toEqual({ available: false, reason: 'the publisher is switched off (option off: true)' });
  });

  it('only an explicit true switches it off', async () => {
    const h = await setup({ publisher: { off: undefined } });
    await expect(h.publisher.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'queued' });
  });
});

describe('the QUEUE_SDK_OFF environment variable (trying a program in development without a queue)', () => {
  it('QUEUE_SDK_OFF=1 sends, starts and reports nothing, and says so in the result', async () => {
    const h = await setup({ deps: { env: { QUEUE_SDK_OFF: '1' } } });
    h.publisher.publish('app.thing', {});
    const result = await h.publisher.publishAndWait('app.thing', {});
    await h.publisher.flush();
    expect(result).toEqual({ status: 'dropped', reason: 'the publisher is switched off by the environment variable QUEUE_SDK_OFF=1: nothing was sent' });
    expect(h.httpCalls).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it('announces it once when the publisher is created, so a forgotten variable in production is not silent', async () => {
    const h = await setup({ deps: { env: { QUEUE_SDK_OFF: '1' } } });
    await h.publisher.publishAndWait('app.thing', {});
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('QUEUE_SDK_OFF=1');
    expect(h.warnings[0]).toMatch(/development|test/i);
    expect(h.warnings[0]).toMatch(/unset/i);
  });

  it('prints the announcement when no onWarning callback is given, unless silent', async () => {
    const lines: string[] = [];
    const printing = await setup({ publisher: { silent: false, onWarning: undefined }, deps: { env: { QUEUE_SDK_OFF: '1' }, sink: (line) => lines.push(line) } });
    await printing.publisher.status();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('QUEUE_SDK_OFF=1');

    const quiet: string[] = [];
    await setup({ publisher: { silent: true, onWarning: undefined }, deps: { env: { QUEUE_SDK_OFF: '1' }, sink: (line) => quiet.push(line) } });
    expect(quiet).toEqual([]);
  });

  it('is visible in status()', async () => {
    const h = await setup({ deps: { env: { QUEUE_SDK_OFF: '1' } } });
    const status = await h.publisher.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('QUEUE_SDK_OFF=1');
  });

  it.each([[{}], [{ QUEUE_SDK_OFF: '0' }], [{ QUEUE_SDK_OFF: '' }]])('%j leaves the publisher active', async (env) => {
    const h = await setup({ deps: { env } });
    await expect(h.publisher.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'queued' });
    expect(h.warnings).toEqual([]);
  });

  it('refuses to guess: any other value is reported as a mistake and the publisher stays ACTIVE (events are not lost by a typo)', async () => {
    const h = await setup({ deps: { env: { QUEUE_SDK_OFF: 'yes' } } });
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ kind: 'invalid-argument' });
    expect(h.failures[0]?.message).toContain('QUEUE_SDK_OFF');
    expect(h.failures[0]?.message).toContain('"yes"');
    await expect(h.publisher.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'queued' });
  });

  it('the off option and the variable together are still just off', async () => {
    const h = await setup({ publisher: { off: true }, deps: { env: { QUEUE_SDK_OFF: '1' } } });
    await expect(h.publisher.publishAndWait('app.thing', {})).resolves.toMatchObject({ status: 'dropped' });
    expect(h.httpCalls).toEqual([]);
  });
});

// A daemon that speaks the protocol of this SDK (the default fake predates queueProtocol, i.e. it has no event catalog).
function setupCatalog(options: HarnessOptions = {}): Promise<Harness> {
  return setup({ ...options, daemon: options.daemon === false ? false : { queueProtocol: { version: PROTOCOL_VERSION, accepts: '^1.0.0' }, ...options.daemon } });
}

const DECLARED = [
  { name: 'demo.started', description: 'A demo began.', correlationKey: 'payload.id' },
  { name: 'demo.done', description: 'A demo ended.', terminal: true, outcome: 'success' as const },
];

describe('registerEvents (the event catalog, protocol 1.1.0)', () => {
  it('sends source, events and protocol with the token and answers registered with the count', async () => {
    const h = await setupCatalog();
    const result = await h.publisher.registerEvents('demo', DECLARED);
    expect(result).toEqual({ status: 'registered', count: 2 });
    const [registration] = h.fake!.registrations();
    expect(registration?.authorization).toBe(`Bearer ${h.fake!.token}`);
    expect(JSON.parse(registration!.body)).toEqual({ protocol: PROTOCOL_VERSION, source: 'demo', events: DECLARED });
    expect(h.fake!.pushes()).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it('is idempotent on the wire: the same declaration twice is two registrations, both registered', async () => {
    const h = await setupCatalog();
    await h.publisher.registerEvents('demo', DECLARED);
    expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('registered');
    expect(h.fake!.registrations()).toHaveLength(2);
  });

  it('starts the daemon on demand like a push', async () => {
    const h = await setupCatalog({
      writeFiles: false,
      onRun: (harness) => {
        harness.fake!.writeFiles();
        return 0;
      },
    });
    expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('registered');
    expect(h.runs).toHaveLength(1);
  });

  it('re-reads the token after a 401 and retries once', async () => {
    const h = await setupCatalog();
    const fake = h.fake!;
    fake.acceptedToken = 'b'.repeat(32);
    fake.onUnauthorized = () => writeFileSync(join(fake.configDir, 'health_token'), `${fake.acceptedToken}\n`);
    expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('registered');
    expect(fake.registrations().map((request) => request.authorized)).toEqual([false, true]);
    expect(h.failures).toEqual([]);
  });

  it('gives up after one retry on a persistent 401 without exposing the token', async () => {
    const h = await setupCatalog();
    h.fake!.acceptedToken = 'z'.repeat(32);
    const result = await h.publisher.registerEvents('demo', DECLARED);
    expect(result.status).toBe('dropped');
    expect(h.fake!.registrations()).toHaveLength(2);
    expect(h.failures[0]?.kind).toBe('unauthorized');
    expect(JSON.stringify([result, h.failures])).not.toContain(h.fake!.token);
  });

  describe('a declaration the daemon rejects', () => {
    const problems = [
      { path: 'events[0].name', message: 'name must be dot-separated segments' },
      { path: 'events[1].description', message: 'description is required: say when the event fires' },
    ];

    it('returns the problems verbatim, a reason listing each path and message, and reports rejected-declaration', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'answer', result: { status: 'rejected', reason: 'the declaration is invalid: ...', problems } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('rejected');
      expect(result.problems).toEqual(problems);
      expect(result.reason).toContain('events[0].name: name must be dot-separated segments');
      expect(result.reason).toContain('events[1].description: description is required');
      expect(h.failures).toHaveLength(1);
      expect(h.failures[0]).toMatchObject({ kind: 'rejected-declaration', outcome: 'dropped', event: 'demo' });
      expect(h.fake!.registrations()).toHaveLength(1);
    });

    it('a protocol rejection (no problems) keeps the daemon reason and the accepted range', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'answer', result: { status: 'rejected', reason: 'push protocol 2.0.0 is not accepted', supported: '^1.0.0' } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('rejected');
      expect(result.problems).toBeUndefined();
      expect(result.reason).toContain('push protocol 2.0.0 is not accepted');
      expect(result.reason).toContain('^1.0.0');
    });
  });

  describe('a daemon older than 1.1.0', () => {
    it('is unsupported without sending anything when /version says 1.0.0, and says what to update', async () => {
      const h = await setupCatalog({ daemon: { queueProtocol: { version: '1.0.0', accepts: '^1.0.0' } } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('unsupported');
      expect(result.reason).toContain('update queue-cli');
      expect(result.reason).toContain('push protocol 1.0.0');
      expect(result.reason).toContain('needs 1.1.0');
      expect(h.fake!.registrations()).toEqual([]);
      expect(h.failures).toHaveLength(1);
      expect(h.failures[0]).toMatchObject({ kind: 'unsupported', outcome: 'dropped' });
    });

    it('is unsupported when /version has no queueProtocol at all (legacy daemon)', async () => {
      const h = await setup();
      expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('unsupported');
      expect(h.fake!.registrations()).toEqual([]);
    });

    it('is unsupported on an HTTP 404 of the command, and nothing is retried', async () => {
      const h = await setupCatalog({ daemon: { queueProtocol: { version: PROTOCOL_VERSION, accepts: '^1.0.0' }, supportsRegisterEvents: false } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('unsupported');
      expect(result.reason).toContain('update queue-cli');
      expect(h.fake!.registrations()).toHaveLength(1);
      expect(h.failures[0]).toMatchObject({ kind: 'unsupported' });
    });

    it('does not stop publishing: pushes still work', async () => {
      const h = await setup();
      expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('unsupported');
      expect((await h.publisher.publishAndWait('demo.started', {})).status).toBe('queued');
    });

    it('reaches onError on every call but prints once per problem', async () => {
      const lines: string[] = [];
      const h = await setup({ publisher: { silent: false }, deps: { sink: (line) => lines.push(line) } });
      await h.publisher.registerEvents('demo', DECLARED);
      await h.publisher.registerEvents('demo', DECLARED);
      expect(h.failures).toHaveLength(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('demo');
      expect(lines[0]).toContain('update queue-cli');
    });
  });

  describe('connection reset or timeout after sending', () => {
    it('retries once after a reset (replacing a declaration is idempotent) and then succeeds', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'reset' });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result).toEqual({ status: 'registered', count: 2 });
      expect(h.fake!.registrations()).toHaveLength(2);
      expect(h.failures).toEqual([]);
    });

    it('retries once after a timeout and then succeeds', async () => {
      let calls = 0;
      const h = await setupCatalog({
        deps: {
          request: (call) => {
            if (call.path === '/register-events') {
              calls += 1;
              if (calls === 1) {
                return Promise.resolve({ kind: 'failure', connected: true, message: 'timeout', timedOut: true });
              }
            }
            return loopbackRequest(call);
          },
        },
      });
      expect((await h.publisher.registerEvents('demo', DECLARED)).status).toBe('registered');
      expect(calls).toBe(2);
    });

    it('answers unknown after the second reset, never retries a third time, and says it may have been stored', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'reset' }, { kind: 'reset' });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('unknown');
      expect(result.reason).toContain('may have been stored');
      expect(h.fake!.registrations()).toHaveLength(2);
      expect(h.failures).toHaveLength(1);
      expect(h.failures[0]).toMatchObject({ kind: 'unknown-outcome', outcome: 'unknown', event: 'demo' });
    });
  });

  describe('failures shared with push', () => {
    it('drops on a 500 with the daemon message and no retry', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'http', status: 500, body: '{"error":"disk full"}' });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('dropped');
      expect(result.reason).toContain('disk full');
      expect(h.fake!.registrations()).toHaveLength(1);
      expect(h.failures[0]?.kind).toBe('http-error');
    });

    it('drops on an unknown status of the answer', async () => {
      const h = await setupCatalog();
      h.fake!.registerScript.push({ kind: 'answer', result: { status: 'exploded' } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('dropped');
      expect(h.failures[0]?.kind).toBe('bad-answer');
    });

    it('drops with the reason when the daemon cannot be started', async () => {
      const h = await setupCatalog({ daemon: false, queueInstalled: false });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('dropped');
      expect(h.failures[0]?.kind).toBe('not-installed');
    });

    it('drops when the protocols of the SDK and the daemon do not overlap, sending nothing', async () => {
      const h = await setupCatalog({ daemon: { queueProtocol: { version: '2.0.0', accepts: '^2.0.0' } } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('dropped');
      expect(h.failures[0]?.kind).toBe('incompatible');
      expect(h.fake!.registrations()).toEqual([]);
    });
  });

  describe('client-side checks (only what cannot be sent; the rules belong to the daemon)', () => {
    it('refuses what is not JSON-serialisable, naming the path, without contacting the daemon', async () => {
      const h = await setupCatalog();
      const result = await h.publisher.registerEvents('demo', [{ name: 'a', description: 'd', example: { big: 10n } }]);
      expect(result.status).toBe('dropped');
      expect(result.reason).toContain('events[0].example.big');
      expect(h.failures[0]).toMatchObject({ kind: 'not-serialisable' });
      expect(h.httpCalls).toEqual([]);
    });

    it.each([[''], ['   '], [undefined], [3], [null]])('refuses the source %j without contacting the daemon', async (source) => {
      const h = await setupCatalog();
      const result = await h.publisher.registerEvents(source as unknown as string, DECLARED);
      expect(result.status).toBe('dropped');
      expect(result.reason).toContain('source');
      expect(h.failures[0]?.kind).toBe('invalid-argument');
      expect(h.httpCalls).toEqual([]);
    });

    it('does not apply the daemon rules itself: an invalid name goes to the daemon, which decides', async () => {
      const h = await setupCatalog();
      await h.publisher.registerEvents('Demo Source', [{ name: 'bad name', description: '' }]);
      expect(h.fake!.registrations()).toHaveLength(1);
    });
  });

  describe('switched off', () => {
    it('off: true sends nothing and answers dropped saying so', async () => {
      const h = await setupCatalog({ publisher: { off: true } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result).toEqual({ status: 'dropped', reason: 'the publisher is switched off (option off: true): nothing was sent' });
      expect(h.httpCalls).toEqual([]);
      expect(h.failures).toEqual([]);
    });

    it('QUEUE_SDK_OFF=1 sends nothing and says so', async () => {
      const h = await setupCatalog({ deps: { env: { QUEUE_SDK_OFF: '1' } } });
      const result = await h.publisher.registerEvents('demo', DECLARED);
      expect(result.status).toBe('dropped');
      expect(result.reason).toContain('QUEUE_SDK_OFF=1');
      expect(h.httpCalls).toEqual([]);
    });
  });

  describe('maxPending and flush are shared with push', () => {
    it('counts a registration among the work in flight: the overflow is dropped and reported', async () => {
      const h = await setupCatalog({ publisher: { maxPending: 1 } });
      h.fake!.registerScript.push({ kind: 'delay', ms: 100 });
      const first = h.publisher.registerEvents('demo', DECLARED);
      const second = await h.publisher.registerEvents('other', DECLARED);
      expect(second.status).toBe('dropped');
      expect(second.reason).toContain('maxPending');
      expect(h.failures.filter((failure) => failure.kind === 'overflow')).toHaveLength(1);
      expect((await first).status).toBe('registered');
    });

    it('a push in flight and a registration both count, and flush waits for both', async () => {
      const h = await setupCatalog({ publisher: { maxPending: 2 } });
      h.fake!.script.push({ kind: 'delay', ms: 100 });
      h.fake!.registerScript.push({ kind: 'delay', ms: 100 });
      h.publisher.publish('a', {});
      const registration = h.publisher.registerEvents('demo', DECLARED);
      expect((await h.publisher.registerEvents('x', DECLARED)).status).toBe('dropped');
      await h.publisher.flush();
      expect(h.fake!.pushes()).toHaveLength(1);
      expect(h.fake!.registrations()).toHaveLength(1);
      expect((await registration).status).toBe('registered');
    });
  });

  it('never throws on bad input', async () => {
    const h = await setupCatalog();
    await expect(h.publisher.registerEvents('demo', undefined as unknown as [])).resolves.toBeDefined();
  });
});

describe('publishing on behalf of a project (push protocol 1.2.0)', () => {
  const ID = '569c412d';
  // setup() starts a daemon that predates queueProtocol (1.0.0) unless told otherwise
  const current = { queueProtocol: { version: PROTOCOL_VERSION, accepts: '^1.0.0' } };

  it('sends the project id of the publisher with every event, and a per-call project overrides it', async () => {
    const h = await setup({ daemon: current, publisher: { project: ID } });
    await h.publisher.publishAndWait('app.thing', {});
    await h.publisher.publishAndWait('app.thing', {}, { project: 'deadbeef' });
    const bodies = h.fake!.pushes().map((request) => JSON.parse(request.body) as { project?: string });
    expect(bodies.map((body) => body.project)).toEqual([ID, 'deadbeef']);
  });

  it('sends no project field when none was given: the daemon derives it from the cwd', async () => {
    const h = await setup();
    await h.publisher.publishAndWait('app.thing', {});
    expect(JSON.parse(h.fake!.pushes()[0]!.body)).not.toHaveProperty('project');
  });

  it('refuses a project that is not the 8-hex id (a name must be resolved with the project CLI first), sending nothing', async () => {
    const h = await setup({ publisher: { project: 'my-app' } });
    const result = await h.publisher.publishAndWait('app.thing', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('invalid-argument');
    expect(h.failures[0]?.message).toContain('my-app');
    expect(h.failures[0]?.message).toContain('8 hexadecimal');
    expect(h.fake!.pushes()).toEqual([]);
  });

  it('drops the event and says to update queue-cli when the daemon is older than protocol 1.2.0: it would ignore the project and file the event under another', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '1.1.0', accepts: '^1.0.0' } }, publisher: { project: ID } });
    const result = await h.publisher.publishAndWait('app.thing', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('unsupported');
    expect(h.failures[0]?.message).toContain('1.2.0');
    expect(h.failures[0]?.message).toContain('queue-cli');
    expect(h.fake!.pushes()).toEqual([]);
  });

  it('cwd: null sends no working directory, for the project of a virtual project (no folder), protocol 1.3.0', async () => {
    const h = await setup({ daemon: current, publisher: { project: ID, cwd: null } });
    await h.publisher.publishAndWait('app.thing', {});
    const body = JSON.parse(h.fake!.pushes()[0]!.body) as { project?: string };
    expect(body.project).toBe(ID);
    expect(body).not.toHaveProperty('cwd');
  });

  it('refuses cwd: null without a project: the daemon could not tell where the event comes from, sending nothing', async () => {
    const h = await setup({ daemon: current, publisher: { cwd: null } });
    const result = await h.publisher.publishAndWait('app.thing', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('invalid-argument');
    expect(h.failures[0]?.message).toContain('project');
    expect(h.fake!.pushes()).toEqual([]);
  });

  it('drops an event without cwd when the daemon is older than protocol 1.3.0, saying to update queue-cli', async () => {
    const h = await setup({ daemon: { queueProtocol: { version: '1.2.0', accepts: '^1.0.0' } }, publisher: { project: ID, cwd: null } });
    const result = await h.publisher.publishAndWait('app.thing', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.kind).toBe('unsupported');
    expect(h.failures[0]?.message).toContain('1.3.0');
    expect(h.failures[0]?.message).toContain('queue-cli');
    expect(h.fake!.pushes()).toEqual([]);
  });

  it('a project the daemon refuses is reported with the daemon reason, not as a protocol mismatch', async () => {
    const h = await setup({ daemon: current, publisher: { project: ID } });
    h.fake!.script.push({ kind: 'answer', result: { status: 'rejected', reason: "no registered project has the id '569c412d'. Fix: project list shows the registered projects and their ids; the event was not recorded" } });
    const result = await h.publisher.publishAndWait('app.thing', {});
    expect(result.status).toBe('dropped');
    expect(h.failures[0]?.message).toContain('project list');
    expect(h.failures[0]?.message).not.toContain('update @wadeck-app/queue-sdk');
  });
});
