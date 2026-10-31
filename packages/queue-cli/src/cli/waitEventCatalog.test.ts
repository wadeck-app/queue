import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSourceDeclaration } from '@wadeck-app/queue-core';
import { queueWaitCommand } from './waitCli.js';

// `queue wait <event>` and the event catalog, in this process: the real command, the real history reader, the real catalog files
// of a throwaway config dir, a relay that cannot start. Every wait ends at once because the event is already in the history, so
// no test waits for anything.

let configDir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-wait-event-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function recordPush(event: string): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(configDir, 'history', `${ts.slice(0, 10)}.ndjson`), JSON.stringify({ ts, type: 'trigger', eventId: `e-${event}`, event, matchedCount: 0, totalCount: 0, payload: {} }) + '\n', { flag: 'a' });
}

function declare(...names: string[]): void {
  writeSourceDeclaration(configDir, { source: 'demo', events: names.map((name) => ({ name, description: `${name} fires` })) });
}

const relayCannotStart = async (): Promise<number> => 1;
const wait = (...args: string[]): Promise<number> => queueWaitCommand(configDir, [...args, '--since', '1h'], relayCannotStart);

describe('queue wait <event> and the event catalog', () => {
  it('waits for a declared event without any warning', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('job.completed')).toBe(0);
    expect(stderr).not.toContain('not declared');
  });

  it('still waits for an undeclared event, and says so with the nearest declared names', async () => {
    declare('job.completed');
    recordPush('job.complete');
    expect(await wait('job.complete')).toBe(0);
    expect(stderr).toContain('"job.complete" is not declared by any program');
    expect(stderr).toContain('did you mean: job.completed');
  });

  it('says no program declared its events yet when the catalog is empty, instead of calling the name a mistake', async () => {
    recordPush('whatever.happened');
    expect(await wait('whatever.happened')).toBe(0);
    expect(stderr).toContain('No program declared its events yet');
  });

  it('--strict refuses an undeclared name at once (exit 4) with the suggestions, and does not wait', async () => {
    declare('job.completed');
    expect(await wait('job.complete', '--strict')).toBe(4);
    expect(stderr).toContain('[fail]');
    expect(stderr).toContain('did you mean: job.completed');
    expect(stderr).not.toContain('waiting for');
  });

  it('--strict --json gives the refusal as JSON on stdout', async () => {
    declare('job.completed');
    expect(await wait('job.complete', '--strict', '--json')).toBe(4);
    expect(JSON.parse(stdout.trim())).toMatchObject({ matched: false, declared: false, suggestions: ['job.completed'] });
  });

  it('--json says whether the name is declared in the result', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('job.completed', '--json')).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ matched: true, declared: true });
  });

  it('events that come from the relay (on.<source>.<type>) are never called undeclared: nobody declares them, even with --strict', async () => {
    declare('job.completed');
    recordPush('on.github.workflow_run');
    expect(await wait('on.github.workflow_run', '--strict')).toBe(0);
    expect(stderr).not.toContain('not declared');
    expect(stderr).not.toContain('No program declared');
  });

  it('waits for several events at once with the real history: the one that happened ends the wait, each name is checked against the catalog', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('job.failed', 'job.completed')).toBe(0);
    expect(stdout).toContain('job.completed');
    expect(stderr).toContain('"job.failed" is not declared by any program');
    expect(stderr).toContain('wait 2 of 2 matched: job.completed');
  });

  it('--strict refuses the whole wait when one of several names is undeclared', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('job.completed', 'job.faild', '--strict')).toBe(4);
  });
});

function recordPushAt(event: string | undefined, agoMs: number, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const ts = new Date(Date.now() - agoMs).toISOString();
  const record = { ts, type: 'trigger', eventId: `e-${event ?? 'orphan'}-${agoMs}`, ...(event !== undefined && { event }), matchedCount: 0, totalCount: 0, payload: {}, ...extra };
  writeFileSync(join(configDir, 'history', `${ts.slice(0, 10)}.ndjson`), JSON.stringify(record) + '\n', { flag: 'a' });
}

describe('queue wait with an event pattern', () => {
  it('"dep.published.*" matches a name that was never declared, without any declaration warning', async () => {
    declare('dep.published.api');
    recordPush('dep.published.web');
    expect(await wait('dep.published.*', '--json')).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result).toMatchObject({ matched: true, entry: { event: 'dep.published.web' } });
    expect(result).not.toHaveProperty('declared');
    expect(result).not.toHaveProperty('suggestions');
    expect(stderr).not.toContain('not declared');
    expect(stderr).not.toContain('no known event');
  });

  it('"dep.>" matches any depth but not "dep" itself', async () => {
    recordPush('dep');
    recordPush('dep.a.b.c');
    expect(await wait('dep.>', '--json')).toBe(0);
    expect(JSON.parse(stdout.trim()).entry.event).toBe('dep.a.b.c');
  });

  it('"dep.*" does not match "dep.a.b" nor "dep": the wait times out', async () => {
    declare('dep.a');
    recordPush('dep.a.b');
    recordPush('dep');
    expect(await wait('dep.*', '--timeout', '1s')).toBe(2);
    expect(stderr).toContain('No event matching "dep.*" was recorded within 1s');
  });

  it('--since: an event older than the window does not satisfy the pattern', async () => {
    recordPushAt('dep.old', 3 * 3600_000);
    expect(await queueWaitCommand(configDir, ['dep.*', '--since', '10m', '--timeout', '1s'], relayCannotStart)).toBe(2);
  });

  it('--when filters the payload of the events matching the pattern', async () => {
    recordPushAt('dep.a', 60_000, { payload: { id: 'x' } });
    recordPushAt('dep.b', 50_000, { payload: { id: 'y' } });
    expect(await wait('dep.*', '--when', 'payload.id=y', '--json')).toBe(0);
    expect(JSON.parse(stdout.trim()).entry.event).toBe('dep.b');
  });

  it('a timeout names the latest matching event (lastSeenEvent) and points to "queue events list --match"', async () => {
    declare('dep.a');
    recordPushAt('dep.a', 3 * 3600_000);
    recordPushAt('dep.b', 2 * 3600_000);
    expect(await queueWaitCommand(configDir, ['dep.*', '--since', '1m', '--timeout', '1s', '--json'], relayCannotStart)).toBe(2);
    expect(JSON.parse(stdout.trim())).toMatchObject({ matched: false, timedOut: true, event: 'dep.*', lastSeenEvent: 'dep.b' });
    expect(stdout).not.toContain('"declared"');
    expect(stderr).toContain('last matching event "dep.b"');
    expect(stderr).toContain('queue events list --match');
  });

  it('a timeout with no known match says so for the last 7 days', async () => {
    declare('other.name');
    expect(await wait('dep.*', '--timeout', '1s')).toBe(2);
    expect(stderr).toContain('no event matching "dep.*" in the last 7 days');
  });

  it('warns when no declared or seen name matches, and --strict does not refuse the pattern', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('dep.*', '--strict', '--timeout', '1s')).toBe(2);
    expect(stderr).toContain('[warn] no known event matches "dep.*"');
    expect(stderr).not.toContain('[fail]');
  });

  it('with an empty catalog and no history the warning is a softer [info]', async () => {
    expect(await wait('dep.*', '--timeout', '1s')).toBe(2);
    expect(stderr).toContain('[info] No program declared its events yet');
    expect(stderr).not.toContain('[warn] no known event');
  });

  it('a pattern and an exact name in one wait: any ends at the one that happened', async () => {
    declare('job.completed');
    recordPush('dep.x');
    expect(await wait('job.completed', 'dep.*')).toBe(0);
    expect(stderr).toContain('wait 2 of 2 matched: dep.*');
  });

  it('--all: the pattern is satisfied by any one name, the exact name must have happened too', async () => {
    declare('job.completed');
    recordPush('dep.x');
    recordPush('dep.y');
    recordPush('job.completed');
    expect(await wait('job.completed', 'dep.*', '--all', '--json')).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.mode).toBe('all');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].entry.event).toBe('job.completed');
    expect(result.entries[1].entry.event).toMatch(/^dep\.[xy]$/);
  });

  it('--all times out while one target is still open, with "pattern": true on the pattern target', async () => {
    declare('job.completed');
    recordPush('dep.x');
    expect(await wait('job.completed', 'dep.*', '--all', '--timeout', '1s', '--json')).toBe(2);
    const result = JSON.parse(stdout.trim());
    expect(result.targets[0]).toMatchObject({ event: 'job.completed', matched: false });
    expect(result.targets[0]).not.toHaveProperty('pattern');
    expect(result.targets[1]).toMatchObject({ event: 'dep.*', pattern: true, matched: true });
  });

  it('">" does not match a record without an event name', async () => {
    recordPushAt(undefined, 60_000);
    expect(await wait('>', '--timeout', '1s')).toBe(2);
  });

  it('a wildcard inside a segment exits 4 with an actionable message, without waiting', async () => {
    expect(await wait('dep.pub*')).toBe(4);
    expect(stderr).toContain('[fail]');
    expect(stderr).toContain('whole segment');
    expect(stderr).not.toContain('waiting for');
  });

  it('a ">" that is not last exits 4', async () => {
    expect(await wait('dep.>.x')).toBe(4);
    expect(stderr).toContain('must be the last');
  });

  it('"dep.**" exits 4 and points to ">", without waiting', async () => {
    expect(await wait('dep.**')).toBe(4);
    expect(stderr).toContain('"dep.**": "**" is not accepted by "queue wait"; use ">" instead: "dep.>"');
    expect(stderr).not.toContain('waiting for');
  });

  it('a bare "**" exits 4 and points to ">"', async () => {
    expect(await wait('**')).toBe(4);
    expect(stderr).toContain('"**" is not accepted by "queue wait"; use ">" instead: ">"');
  });

  it('"dep.**.x" says "**" is not accepted (not the position error)', async () => {
    expect(await wait('dep.**.x')).toBe(4);
    expect(stderr).toContain('use ">"');
  });

  it('a segment mixing ">" with other characters gives the "whole segment" error', async () => {
    expect(await wait('dep.a>')).toBe(4);
    expect(stderr).toContain('whole segment');
  });

  it('a name ending with a dot (what an unquoted "dep.>" leaves after the shell redirect) exits 4 with a hint', async () => {
    expect(await wait('dep.')).toBe(4);
    expect(stderr).toContain('redirect');
    expect(stderr).toContain('quote the pattern');
    expect(stderr).toContain('"dep.>"');
  });

  it('a pattern starting with "on." starts the relay and skips the known-event warning', async () => {
    declare('job.completed');
    expect(await wait('on.github.*', '--timeout', '1s')).toBe(2);
    expect(stderr).toContain('The relay client is not running');
    expect(stderr).not.toContain('no known event');
  });

  it('a bare ">" says it does not start the relay, and does not start it', async () => {
    declare('job.completed');
    recordPush('job.completed');
    expect(await wait('>')).toBe(0);
    expect(stderr).toContain('does not start the relay client');
    expect(stderr).not.toContain('The relay client is not running');
  });
});
