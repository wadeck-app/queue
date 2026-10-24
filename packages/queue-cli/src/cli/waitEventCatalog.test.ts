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
});
