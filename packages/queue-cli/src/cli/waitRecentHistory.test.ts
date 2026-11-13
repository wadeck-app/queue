/**
 * `queue wait` with its own history reader (no injected one): it must find the push in a real history directory, and it must not open the day files that
 * are older than its window (they are directories here, which cannot be read: any read of them throws).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WaiterRegistry } from '@wadeck-app/queue-core';
import { queueWaitCommand } from './waitCli.js';
import { fakeWaitSession } from '../testing/fakeWaitSession.js';

let configDir: string;
let stdout: string;
const NOW = Date.parse('2026-03-10T12:00:00.000Z');

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-wait-recent-'));
  stdout = '';
  mkdirSync(join(configDir, 'history'));
  // Older days: unreadable on purpose
  mkdirSync(join(configDir, 'history', '2026-02-01.ndjson'));
  mkdirSync(join(configDir, 'history', '2026-03-01.ndjson'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function writeToday(records: object[]): void {
  writeFileSync(join(configDir, 'history', '2026-03-10.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function wait(args: string[]): Promise<number> {
  const registry = new WaiterRegistry(configDir);
  const session = fakeWaitSession({
    sweepStale: () => registry.sweepStale(),
    register: (input) => registry.register(input),
    heartbeat: (registration) => registry.heartbeat(registration),
    deregister: (registration, end) => registry.deregister(registration, end),
  });
  // A fake clock that the sleeps move, so that a wait that finds nothing reaches its timeout
  const clock = { ms: NOW };
  return queueWaitCommand(configDir, args, async () => 1, { session: session.deps, now: () => clock.ms, sleep: async (ms) => { clock.ms += ms; }, pid: 4242 });
}

const trigger = (eventId: string, event: string, atMs: number): object => ({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId, event, matchedCount: 0, totalCount: 0, payload: { eventId } });

describe('queue wait with the real history reader', () => {
  it('finds an event of its window, and only reads the days of its window', async () => {
    writeToday([trigger('e-other', 'onOther', NOW - 4000), trigger('e-1', 'onDone', NOW - 3000)]);

    const code = await wait(['onDone', '--name', 'w.recent1', '--since', '1h', '--timeout', '1s']);

    expect(code).toBe(0);
    expect(stdout).toContain('eventId e-1');
  });

  it('finds an event by pattern in the same window', async () => {
    writeToday([trigger('e-1', 'dep.done', NOW - 3000), trigger('e-2', 'unrelated', NOW - 2000)]);

    const code = await wait(['dep.*', '--name', 'w.recent2', '--since', '1h', '--timeout', '1s']);

    expect(code).toBe(0);
    expect(stdout).toContain('eventId e-1');
  });

  it('times out (2) when the window holds no such event', async () => {
    writeToday([trigger('e-1', 'onDone', NOW - 2 * 3_600_000)]);

    expect(await wait(['onDone', '--name', 'w.recent3', '--since', '1h', '--timeout', '1s'])).toBe(2);
  });
});
